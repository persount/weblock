
import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import { Readable } from 'stream'
import { proto } from '../../WAProto'
import { randomBytes } from 'crypto'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import { AnyMessageContent, Media, MediaConnInfo, MessageReceiptType, MessageRelayOptions, MiscMessageGenerationOptions, QueryIds, SocketConfig, WAMediaUploadFunctionOpts, WAMessageKey, XWAPaths } from '../Types'
import { aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData, delay, encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, extractDeviceJids, generateMessageID, generateWAMessage, generateWAMessageFromContent, getContentType, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, parseAndInjectE2ESessions, unixTimestampSeconds, normalizeMessageContent } from '../Utils'
import { getUrlInfo } from '../Utils/link-preview'
import { areJidsSameUser, BinaryNode, BinaryNodeAttributes, getAdditionalNode, getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeFilter, isJidGroup, isJidNewsletter, isJidUser, jidDecode, jidEncode, jidNormalizedUser, JidWithDevice, S_WHATSAPP_NET, STORIES_JID } from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { makeNewsletterSocket } from './newsletter'
import ListType = proto.Message.ListMessage.ListType;

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: axiosOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
		customMessageID
	} = config
	const felz = makeNewsletterSocket(config)
	const {
		ev,
		authState,
		processingMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		sendNode,
		groupQuery,
		groupMetadata,
		groupToggleEphemeral,
		newsletterWMexQuery,
	} = felz

	const userDevicesCache = config.userDevicesCache || new NodeCache({
		stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
		useClones: false
	})

	let mediaConn: Promise<MediaConnInfo>
	const refreshMediaConn = async(forceGet = false) => {
		const media = await mediaConn
		if(!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
			mediaConn = (async() => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET,
					},
					content: [ { tag: 'media_conn', attrs: { } } ]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(
						({ attrs }) => ({
							hostname: attrs.hostname,
							maxContentLengthBytes: +attrs.maxContentLengthBytes,
						})
					),
					auth: mediaConnNode!.attrs.auth,
					ttl: +mediaConnNode!.attrs.ttl,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				return node
			})()
		}

		return mediaConn
	}

	/**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
	const sendReceipt = async(jid: string, participant: string | undefined, messageIds: string[], type: MessageReceiptType) => {
		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0],
			},
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if(isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if(type === 'sender' && isJidUser(jid)) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if(participant) {
				node.attrs.participant = participant
			}
		}

		if(type) {
			node.attrs.type = isJidNewsletter(jid) ? 'read-self' : type
		}

		const remainingMessageIds = messageIds.slice(1)
		if(remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: { },
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async(keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		for(const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async(keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async(jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => {
		const deviceResults: JidWithDevice[] = []

		if(!useCache) {
			logger.debug('not using cache for devices')
		}

		const toFetch: string[] = []
		jids = Array.from(new Set(jids))

		for(let jid of jids) {
			const user = jidDecode(jid)?.user
			jid = jidNormalizedUser(jid)
			if(useCache) {
				const devices = userDevicesCache.get<JidWithDevice[]>(user!)
				if(devices) {
					deviceResults.push(...devices)

					logger.trace({ user }, 'using cache for devices')
				} else {
					toFetch.push(jid)
				}
			} else {
				toFetch.push(jid)
			}
		}

		if(!toFetch.length) {
			return deviceResults
		}

		const query = new USyncQuery()
			.withContext('message')
			.withDeviceProtocol()

		for(const jid of toFetch) {
			query.withUser(new USyncUser().withId(jid))
		}

		const result = await felz.executeUSyncQuery(query)

		if(result) {
			const extracted = extractDeviceJids(result?.list, authState.creds.me!.id, ignoreZeroDevices)
			const deviceMap: { [_: string]: JidWithDevice[] } = {}

			for(const item of extracted) {
				deviceMap[item.user] = deviceMap[item.user] || []
				deviceMap[item.user].push(item)

				deviceResults.push(item)
			}

			for(const key in deviceMap) {
				userDevicesCache.set(key, deviceMap[key])
			}
		}

		return deviceResults
	}
	
	const profilePictureUrl = async (jid: string, type: 'preview' | 'image' = 'preview', timeoutMs ? : number) => {
     jid = jidNormalizedUser(jid)
     if (isJidNewsletter(jid)) {
        const node = await newsletterWMexQuery(undefined, QueryIds.METADATA, {
		       input: {
		          key: jid,
		          type: "JID",
		          view_role: 'GUEST'
		       },
				   fetch_viewer_metadata: true,
			     fetch_full_image: true,
			   	 fetch_creation_time: true
	      })	  
	      const result = getBinaryNodeChild(node, 'result')?.content?.toString()
	      const metadataPath = JSON.parse(result!).data[XWAPaths.NEWSLETTER]
	      const pictype = type === 'image' 
	         ? 'picture' 
	         : 'preview'
        const directPath = metadataPath?.thread_metadata[pictype]?.direct_path
	      return directPath ? getUrlFromDirectPath(directPath) : null
     } else {
        const result = await query({
           tag: 'iq',
           attrs: {
              target: jid,
              to: S_WHATSAPP_NET,
              type: 'get',
              xmlns: 'w:profile:picture'
           },
           content: [
              { tag: 'picture', attrs: { type, query: 'url' } }
           ]
        }, timeoutMs)
        const child = getBinaryNodeChild(result, 'picture')
        return child?.attrs?.url
     }
  }

	const assertSessions = async(jids: string[], force: boolean) => {
		let didFetchNewSession = false
		let jidsRequiringFetch: string[] = []
		if(force) {
			jidsRequiringFetch = jids
		} else {
			const addrs = jids.map(jid => (
				signalRepository
					.jidToSignalProtocolAddress(jid)
			))
			const sessions = await authState.keys.get('session', addrs)
			for(const jid of jids) {
				const signalId = signalRepository
					.jidToSignalProtocolAddress(jid)
				if(!sessions[signalId]) {
					jidsRequiringFetch.push(jid)
				}
			}
		}

		if(jidsRequiringFetch.length) {
			logger.debug({ jidsRequiringFetch }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'encrypt',
					type: 'get',
					to: S_WHATSAPP_NET,
				},
				content: [
					{
						tag: 'key',
						attrs: { },
						content: jidsRequiringFetch.map(
							jid => ({
								tag: 'user',
								attrs: { jid },
							})
						)
					}
				]
			})
			await parseAndInjectE2ESessions(result, signalRepository)

			didFetchNewSession = true
		}

		return didFetchNewSession
	}

	const sendPeerDataOperationMessage = async(
		pdoMessage: proto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if(!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}
		const protocolMessage: proto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}
		const meJid = jidNormalizedUser(authState.creds.me.id)!
		const msgId = await relayMessage(meJid, protocolMessage, {
			additionalAttributes: {
				category: 'peer',
				// eslint-disable-next-line camelcase
				push_priority: 'high_force',
			},
		})
		return await msgId!
	}

	const createParticipantNodes = async(
		jids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs']
	) => {
		let patched = await patchMessageBeforeSending(message, jids)
		if(!Array.isArray(patched)) {
		  patched = jids ? jids.map(jid => ({ recipientJid: jid, ...patched })) : [patched]
		}

		let shouldIncludeDeviceIdentity = false
		const nodes = await Promise.all(
			patched.map(
				async patchedMessageWithJid => {
				  const { recipientJid: jid, ...patchedMessage } = patchedMessageWithJid
				  if(!jid) {
					  return {} as BinaryNode
					}
					const bytes = encodeWAMessage(patchedMessage)
					const { type, ciphertext } = await signalRepository
						.encryptMessage({ jid, data: bytes })
					if(type === 'pkmsg') {
						shouldIncludeDeviceIdentity = true
					}

					const node: BinaryNode = {
						tag: 'to',
						attrs: { jid },
						content: [{
							tag: 'enc',
							attrs: {
								v: '2',
								type,
								...extraAttrs || {}
							},
							content: ciphertext
						}]
					}
					return node
				}
			)
		)
		return { nodes, shouldIncludeDeviceIdentity }
	}

	const relayMessage = async(
		jid: string,
		message: proto.IMessage,
		{ messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }: MessageRelayOptions
	) => {
		const meId = authState.creds.me!.id

		let shouldIncludeDeviceIdentity = false
    let didPushAdditional = false

		const { user, server } = jidDecode(jid)!
		const statusJid = 'status@broadcast'
		const isGroup = server === 'g.us'
		const isNewsletter = server == 'newsletter'
		const isStatus = jid === statusJid
		const isLid = server === 'lid'
    const isPerson = server === 's.whatsapp.net'
    const isBot = server === 'bot'

		msgId = msgId || await customMessageID(meId) || generateMessageID()
		useUserDevicesCache = useUserDevicesCache !== false
		useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

		const participants: BinaryNode[] = []
		const destinationJid = (!isStatus) ? jidEncode(user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : isBot ? 'bot' : 's.whatsapp.net') : statusJid
		const binaryNodeContent: BinaryNode[] = []
		const devices: JidWithDevice[] = []

		const meMsg: proto.IMessage = {
			deviceSentMessage: {
				destinationJid,
				message
			}
		}

		const extraAttrs = {}

		if(participant) {
			// when the retry request is not for a group
			// only send to the specific device that asked for a retry
			// otherwise the message is sent out to every device that should be a recipient
			if(!isGroup && !isStatus) {
				additionalAttributes = { ...additionalAttributes, 'device_fanout': 'false' }
			}

			const { user, device } = jidDecode(participant.jid)!
			devices.push({ user, device })
		}

		await authState.keys.transaction(
			async() => {
				const mediaType = getMediaType(message)
				if(mediaType) {
					extraAttrs['mediatype'] = mediaType
				}
				if(normalizeMessageContent(message)?.pinInChatMessage) {
					extraAttrs['decrypt-fail'] = 'hide'
				}

				if(isGroup || isStatus) {
					const [groupData, senderKeyMap] = await Promise.all([
						(async() => {
							let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
							if(groupData && Array.isArray(groupData?.participants)) {
								logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
							
								} else if(!isStatus) {
								groupData = await groupMetadata(jid)
							}

							return groupData
						})(),
						(async() => {
							if(!participant && !isStatus) {
								const result = await authState.keys.get('sender-key-memory', [jid])
								return result[jid] || { }
							}

							return { }
						})()
					])

					if(!participant) {
						const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : []
						if(isStatus && statusJidList) {
							participantsList.push(...statusJidList)
						}

						if(!isStatus) {
							additionalAttributes = {
								...additionalAttributes,
								// eslint-disable-next-line camelcase
								addressing_mode: groupData?.addressingMode || 'pn'
							}
						}

						const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
						devices.push(...additionalDevices)
					}

					const patched = await patchMessageBeforeSending(message)

					if(Array.isArray(patched)) {
					  throw new Boom('Per-jid patching is not supported in groups')
					}

					const bytes = encodeWAMessage(patched)

					const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage(
						{
							group: destinationJid,
							data: bytes,
							meId,
						}
					)

					const senderKeyJids: string[] = []
					// ensure a connection is established with every device
					for(const { user, device } of devices) {
						const jid = jidEncode(user, groupData?.addressingMode === 'lid' ? 'lid' : 's.whatsapp.net', device)
						if(!senderKeyMap[jid] || !!participant) {
							senderKeyJids.push(jid)
							// store that this person has had the sender keys sent to them
							senderKeyMap[jid] = true
						}
					}

					// if there are some participants with whom the session has not been established
					// if there are, we re-send the senderkey
					if(senderKeyJids.length) {
						logger.debug({ senderKeyJids }, 'sending new sender key')

						const senderKeyMsg: proto.IMessage = {
							senderKeyDistributionMessage: {
								axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
								groupId: destinationJid
							}
						}

						await assertSessions(senderKeyJids, false)

						const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs)
						shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

						participants.push(...result.nodes)
					}

					binaryNodeContent.push({
						tag: 'enc',
						attrs: { v: '2', type: 'skmsg' },
						content: ciphertext
					})

					await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
				} else if(isNewsletter) {
				    // Message edit
					if (message.protocolMessage?.editedMessage) {
						msgId = message.protocolMessage.key?.id!
						message = message.protocolMessage.editedMessage
					}

					// Message delete
					if (message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
						msgId = message.protocolMessage.key?.id!
						message = {}
					}

					const patched = await patchMessageBeforeSending(message, [])

					if(Array.isArray(patched)) {
					  throw new Boom('Per-jid patching is not supported in channel')
					}

					const bytes = encodeNewsletterMessage(patched)

					binaryNodeContent.push({
						tag: 'plaintext',
						attrs: mediaType ? { mediatype: mediaType } : {},
						content: bytes
					})
				} else {
					const { user: meUser, device: meDevice } = jidDecode(meId)!

					if(!participant) {
						devices.push({ user })
						// do not send message to self if the device is 0 (mobile)
						if(!(additionalAttributes?.['category'] === 'peer' && user === meUser)) {
							if(meDevice !== undefined && meDevice !== 0) {
								devices.push({ user: meUser })
							}
							const additionalDevices = await getUSyncDevices([ meId, jid ], !!useUserDevicesCache, true)
							devices.push(...additionalDevices)
						}
					}

					const allJids: string[] = []
					const meJids: string[] = []
					const otherJids: string[] = []
					for(const { user, device } of devices) {
						const isMe = user === meUser
						const jid = jidEncode(isMe && isLid ? authState.creds?.me?.lid!.split(':')[0] || user : user, isLid ? 'lid' : 's.whatsapp.net', device)
						if(isMe) {
							meJids.push(jid)
						} else {
							otherJids.push(jid)
						}

						allJids.push(jid)
					}

					await assertSessions(allJids, false)

					const [
						{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
						{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
					] = await Promise.all([
						createParticipantNodes(meJids, meMsg, extraAttrs),
						createParticipantNodes(otherJids, message, extraAttrs)
					])
					participants.push(...meNodes)
					participants.push(...otherNodes)

					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
				}

				if(participants.length) {
					if(additionalAttributes?.['category'] === 'peer') {
						const peerNode = participants[0]?.content?.[0] as BinaryNode
						if(peerNode) {
							binaryNodeContent.push(peerNode) // push only enc
						}
					} else {
						binaryNodeContent.push({
							tag: 'participants',
							attrs: { },
							content: participants
						})
					}
				}

				const stanza: BinaryNode = {
					tag: 'message',
					attrs: {
						id: msgId!,
						type: isNewsletter ? getTypeMessage(message) : 'text',
						...(additionalAttributes || {})
					},
					content: binaryNodeContent
				}
				// if the participant to send to is explicitly specified (generally retry recp)
				// ensure the message is only sent to that person
				// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
				if(participant) {
					if(isJidGroup(destinationJid)) {
						stanza.attrs.to = destinationJid
						stanza.attrs.participant = participant.jid
					} else if(areJidsSameUser(participant.jid, meId)) {
						stanza.attrs.to = participant.jid
						stanza.attrs.recipient = destinationJid
					} else {
						stanza.attrs.to = participant.jid
					}
				} else {
					stanza.attrs.to = destinationJid
				}

				if(shouldIncludeDeviceIdentity) {
					(stanza.content as BinaryNode[]).push({
						tag: 'device-identity',
						attrs: { },
						content: encodeSignedDeviceIdentity(authState.creds.account!, true)
					})

					logger.debug({ jid }, 'adding device identity')
				}

				const messageContent = normalizeMessageContent(message)! 
				if(messageContent && !messageContent?.messageContextInfo?.messageSecret) {
				  messageContent.messageContextInfo = {
            messageSecret: randomBytes(32),
            ...messageContent.messageContextInfo
          }
        }
        
				const buttonType = getButtonType(messageContent)
        if(!isNewsletter && buttonType) {
           if(!stanza.content || !Array.isArray(stanza.content)) {
              stanza.content = []
           }
           if(additionalNodes && !Array.isArray(additionalNodes)) {
              return [additionalNodes]
           }
           const content = getAdditionalNode(buttonType)
           const items = getBinaryNodeFilter(additionalNodes ?? [])
           if(items) {
              (stanza.content as BinaryNode[]).push(...additionalNodes!)
              didPushAdditional = true
           } else {
              (stanza.content as BinaryNode[]).push(...content)
           }
           logger.debug({ jid }, 'adding business node')
        } 
            
        if(isPerson) {
           if(!stanza.content || !Array.isArray(stanza.content)) {
             stanza.content = []
           }
           if(additionalNodes && !Array.isArray(additionalNodes)) {
              return [additionalNodes]
           }
				   const nodes = getAdditionalNode('bot')
           const bizBot = getBinaryNodeFilter(additionalNodes ?? [])
           if(bizBot) {
             (stanza.content as BinaryNode[]).push(...additionalNodes!)
             didPushAdditional = true
           } else {
             (stanza.content as BinaryNode[]).push(...nodes)
           }
			  }
			  
			  if(!didPushAdditional && additionalNodes && additionalNodes.length > 0) {
				   if(!stanza.content || !Array.isArray(stanza.content)) {
              stanza.content = []
           }
           (stanza.content as BinaryNode[]).push(...additionalNodes)            
				}
				               
				logger.debug({ msgId }, `sending message to ${participants.length} devices`)

				await sendNode(stanza)
			}
		)

		return msgId
	}

	const getTypeMessage = (msg: proto.IMessage) => {
		if (msg.viewOnceMessage) {
			return getTypeMessage(msg.viewOnceMessage.message!)
		} else if (msg.viewOnceMessageV2) {
			return getTypeMessage(msg.viewOnceMessageV2.message!)
		} else if (msg.viewOnceMessageV2Extension) {
			return getTypeMessage(msg.viewOnceMessageV2Extension.message!)
		} else if (msg.ephemeralMessage) {
			return getTypeMessage(msg.ephemeralMessage.message!)
		} else if (msg.documentWithCaptionMessage) {
			return getTypeMessage(msg.documentWithCaptionMessage.message!)
		} else if (msg.reactionMessage) {
			return 'reaction'
		} else if (getMediaType(msg)) {
			return 'media'
		} else {
			return 'text'
		}
	}

	const getMediaType = (message: proto.IMessage) => {
		if(message.imageMessage) {
			return 'image'
		} else if(message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video'
		} else if(message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio'
		} else if(message.contactMessage) {
			return 'vcard'
		} else if(message.documentMessage) {
			return 'document'
		} else if(message.contactsArrayMessage) {
			return 'contact_array'
		} else if(message.liveLocationMessage) {
			return 'livelocation'
		} else if(message.stickerMessage) {
			return 'sticker'
		} else if(message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if(message.orderMessage) {
			return 'order'
		} else if(message.productMessage) {
			return 'product'
		} else if(message.interactiveResponseMessage) {
			return 'native_flow_response'
		} else if(message.groupInviteMessage) {
			return 'url'
		}
	}

	const getButtonType = (msg: proto.IMessage) => {
		if(msg.buttonsMessage) {
			return 'buttons'
		} else if(msg.templateMessage) {
			return 'template'
    } else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'review_and_pay') {
      return 'review_and_pay'
    } else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'review_order') {
      return 'review_order'
    } else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_info') {
      return 'payment_info'
		} else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_status') {
      return 'payment_status'
		} else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_method') {
      return 'payment_method'
		} else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'cta_catalog') {
      return 'cta_catalog'
		} else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'mpm') {
      return 'mpm'
		} else if(msg.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'call_permission_request') {
      return 'call_request'
		} else if(msg.interactiveMessage && msg.interactiveMessage?.nativeFlowMessage) {
			return 'interactive'
		} else if(msg.listMessage) {
			return 'list'
    }
	}

	const getButtonArgs = (message: proto.IMessage): BinaryNode['attrs'] => {
		if(message.templateMessage) {
			// TODO: Add attributes
			return {}
		} else if(message.listMessage) {
			const type = message.listMessage.listType
			if(!type) {
				throw new Boom('Expected list type inside message')
			}

			return { v: '2', type: ListType[type].toLowerCase() }
		} else {
			return {}
		}
	}

	const getPrivacyTokens = async(jids: string[]) => {
		const t = unixTimestampSeconds().toString()
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy'
			},
			content: [
				{
					tag: 'tokens',
					attrs: { },
					content: jids.map(
						jid => ({
							tag: 'token',
							attrs: {
								jid: jidNormalizedUser(jid),
								t,
								type: 'trusted_contact'
							}
						})
					)
				}
			]
		})

		return result
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

	return {
		...felz,
		getPrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		getButtonArgs,
		readMessages,
		refreshMediaConn,
	  waUploadToServer,
		fetchPrivacySettings,
		getUSyncDevices,
		profilePictureUrl,
		createParticipantNodes,
		sendPeerDataOperationMessage,
		updateMediaMessage: async(message: proto.IWebMessageInfo) => {
			const content = assertMediaContent(message.message)
			const mediaKey = content.mediaKey!
			const meId = authState.creds.me!.id
			const node = await encryptMediaRetryRequest(message.key, mediaKey, meId)

			let error: Error | undefined = undefined
			await Promise.all(
				[
					sendNode(node),
					waitForMsgMediaUpdate(async(update) => {
						const result = update.find(c => c.key.id === message.key.id)
						if(result) {
							if(result.error) {
								error = result.error
							} else {
								try {
									const media = await decryptMediaRetryData(result.media!, mediaKey, result.key.id!)
									if(media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
										const resultStr = proto.MediaRetryNotification.ResultType[media.result!]
										throw new Boom(
											`Media re-upload failed by device (${resultStr})`,
											{ data: media, statusCode: getStatusCodeForMediaRetry(media.result!) || 404 }
										)
									}

									content.directPath = media.directPath
									content.url = getUrlFromDirectPath(content.directPath!)

									logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
								} catch(err) {
									error = err
								}
							}

							return true
						}
					})
				]
			)

			if(error) {
				throw error
			}

			ev.emit('messages.update', [
				{ key: message.key, update: { message: message.message } }
			])

			return message
		},
		sendStatusMentions: async(
		   content: AnyMessageContent, 
		   jids: string[] = []
		) => { 
		   const userJid = jidNormalizedUser(authState.creds.me!.id) 		       
       let allUsers: string[] = [];

       for(const id of jids) {
		      const { user, server } = jidDecode(id)!
		      const isGroup = server === 'g.us'
          const isPerson = server === 's.whatsapp.net'
          if(isGroup) {
             let metadata = await groupMetadata(id)
             let participant = await metadata.participants
             let users = await Promise.all(participant.map(u => jidNormalizedUser(u.id))); 
             allUsers = [...allUsers as string[], ...users as string[]];
          } else if(isPerson) {
             let users = await Promise.all(jids.map(id => id.replace(/\b\d{18}@.{4}\b/g, '')));
             allUsers = [...allUsers as string[], ...users as string[]];
          }
          if(!allUsers.find(user => user.includes(userJid))) {
             (allUsers as string[]).push(userJid)
          }
       };
       const getRandomHexColor = () => {
          return "#" + Math.floor(Math.random() * 16777215)
             .toString(16)
             .padStart(6, "0");
       }
       let mediaHandle;
       let msg = await generateWAMessage(
          STORIES_JID, 
          content, 
          {
				     logger,
				     userJid,
				     getUrlInfo: text => getUrlInfo(
					    	text,
						    {
							     thumbnailWidth: linkPreviewImageThumbnailWidth,
						       fetchOpts: {
								      timeout: 3_000,
								      ...axiosOptions || { }
							     },
							     logger,
							     uploadImage: generateHighQualityLinkPreview
							        ? waUploadToServer
							        : undefined
						    },
				     ),
				     upload: async(readStream: Readable, opts: WAMediaUploadFunctionOpts) => {
						    const up = await waUploadToServer(readStream, { ...opts })
					      mediaHandle = up.handle
					      return up
			       },
				     mediaCache: config.mediaCache,
				     options: config.options,
             backgroundColor: getRandomHexColor(),
             font: Math.floor(Math.random() * 9),
          }
       );
       if(msg) {
          msg?.message?.messageContextInfo = {
             messageSecret: randomBytes(32),
          }
       }
       await relayMessage(STORIES_JID, msg.message!, { 
          messageId: msg.key.id!, 
          statusJidList: allUsers,
          additionalNodes: [
             {
                tag: 'meta',
                attrs: { },
                content: [
                   { 
                      tag: 'mentioned_users',
                      attrs: { },
                      content: jids.map(jid => ({
                         tag: 'to',
                         attrs: { jid },
                         content: [],
                      })),
                   },
                ],
             },
          ], 
       });
       jids.forEach(async id => {
          id = jidNormalizedUser(id)!
		      const { user, server } = jidDecode(id)!
          const isGroup = server === 'g.us'
          let type = isGroup
             ? 'groupStatusMentionMessage' 
             : 'statusMentionMessage'
          await relayMessage(
             id, 
             {
                [type]: {
                   message: {
                      messageContextInfo: {
                         messageSecret: randomBytes(32),
                      },
                      protocolMessage: {
                         key: msg.key,
                         type: 25,
                      },
                   },
                },
             }, 
          { });
          await delay(2500)       
       });
       return msg
    },
		sendAlbumMessage: async(
		  jid: string, 
		  medias: Media[], 
		  options: MiscMessageGenerationOptions = { }
		) => {
       const userJid = authState.creds.me!.id;
       for (const media of medias) {
         if (!media.image && !media.video) throw new TypeError(`medias[i] must have image or video property`)
       }
             
       const time = options.delay || 500
       delete options.delay

       const album = await generateWAMessageFromContent(
          jid,
          {
             messageContextInfo: {
                messageSecret: randomBytes(32),
             },
             albumMessage: {
                expectedImageCount: medias.filter(media => media.image).length,
                expectedVideoCount: medias.filter(media => media.video).length,
                ...options
             }
          },
          { userJid, ...options }
       );

       await relayMessage(jid, album.message!,
          { messageId: album.key.id! }
       )

       let mediaHandle;
       let msg;
       for (const i in medias) {
          const media = medias[i]
          if(media.image) {
             msg = await generateWAMessage(
                 jid,
                 { 
                    image: media.image,
                    ...media,
                    ...options
                 },
                 { 
                    userJid,
                    upload: async(readStream, opts) => {
                       const up = await waUploadToServer(readStream, { ...opts, newsletter: isJidNewsletter(jid) });
                       mediaHandle = up.handle;
                       return up;
                    },
                    ...options, 
                 }
             )
          } else if(media.video) {
             msg = await generateWAMessage(
                 jid,
                 { 
                    video: media.video,
                    ...media,
                    ...options
                 },
                 { 
                    userJid,
                    upload: async(readStream, opts) => {
                       const up = await waUploadToServer(readStream, { ...opts, newsletter: isJidNewsletter(jid) });
                       mediaHandle = up.handle;
                       return up;
                    },
                    ...options, 
                 }
             )
          }
                
          if(msg) {
             msg.message.messageContextInfo = {
                messageSecret: randomBytes(32),
                messageAssociation: {
                   associationType: 1,
                   parentMessageKey: album.key!
                }
             }
          }

          await relayMessage(jid, msg.message!,
             { messageId: msg.key.id! }
          )
          await delay(time)
       }
       return album
    },
		sendMessage: async(
			jid: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions = { }
		) => {
			const userJid = authState.creds.me!.id
			if(
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value = typeof disappearingMessagesInChat === 'boolean' ?
					(disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) :
					disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else {
				let mediaHandle
        let eph
		    if(isJidGroup(jid)) {
		       delete options.ephemeralExpiration
           const node = await groupQuery(
              jid,
              'get',
              [{
                 tag: 'query',
                 attrs: { request: 'interactive' }
			        }]
           )
           let data = getBinaryNodeChild(node, 'group')!
           let exp = getBinaryNodeChild(data, 'ephemeral')!
           eph = exp?.attrs?.expiration
        } else {
           eph = options.ephemeralExpiration || 0
        }
				const fullMsg = await generateWAMessage(
					jid,
					content,
					{
						logger,
						userJid,
						getUrlInfo: text => getUrlInfo(
							text,
							{
								thumbnailWidth: linkPreviewImageThumbnailWidth,
								fetchOpts: {
									timeout: 3_000,
									...axiosOptions || { }
								},
								logger,
								uploadImage: generateHighQualityLinkPreview
									? waUploadToServer
									: undefined
							},
						),
						upload: async(readStream: Readable, opts: WAMediaUploadFunctionOpts) => {
							const up = await waUploadToServer(readStream, { ...opts, newsletter: isJidNewsletter(jid) })
							mediaHandle = up.handle
							return up
						},
						mediaCache: config.mediaCache,
						options: config.options,
						messageId: await customMessageID(userJid) || generateMessageID(),
						ephemeralExpiration: eph,
						...options,
					}
				)
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const isKeepMsg = 'keep' in content && content.keep
				const isPollMessage = 'poll' in content && !!content.poll
				const isAiMsg = 'ai' in content && !!content.ai
				const additionalAttributes: BinaryNodeAttributes = { }
				const additionalNodes: BinaryNode[] = []
				// required for delete
				if(isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if((isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) || isJidNewsletter(jid)) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				// required for edit message
				} else if(isEditMsg) {
					additionalAttributes.edit = isJidNewsletter(jid) ? '3' : '1'
				// required for pin message
				} else if(isPinMsg) {
					additionalAttributes.edit = '2'
				// required for keep message
				} else if(isAiMsg) {
					additionalNodes.push({
						attrs: {
							biz_bot: '1'
						},
						tag: "bot"
					})
          if(options.additionalNodes) {
            (additionalNodes as BinaryNode[]).push(...options.additionalNodes)
          }
				}

				if (mediaHandle) {
					additionalAttributes['media_id'] = mediaHandle
				}

				if('cachedGroupMetadata' in options) {
					console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.')
				}

				await relayMessage(jid, fullMsg.message!, { messageId: fullMsg.key.id!, useCachedGroupMetadata: options.useCachedGroupMetadata, additionalAttributes, additionalNodes: isAiMsg ? additionalNodes : options.additionalNodes, statusJidList: options.statusJidList })
				if(config.emitOwnEvents) {
					process.nextTick(() => {
						processingMutex.mutex(() => (
							upsertMessage(fullMsg, 'append')
						))
					})
				}

				return fullMsg
			}
		}
	}
}
