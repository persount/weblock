import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto'
import { BinaryNode } from './types'

// some extra useful utilities

export const getBinaryNodeChildren = (node: BinaryNode | undefined, childTag: string) => {
	if(Array.isArray(node?.content)) {
		return node.content.filter(item => item.tag === childTag)
	}

	return []
}

export const getAllBinaryNodeChildren = ({ content }: BinaryNode) => {
	if(Array.isArray(content)) {
		return content
	}

	return []
}

export const getBinaryNodeChild = (node: BinaryNode | undefined, childTag: string) => {
	if(Array.isArray(node?.content)) {
		return node?.content.find(item => item.tag === childTag)
	}
}

export const getBinaryNodeChildBuffer = (node: BinaryNode | undefined, childTag: string) => {
	const child = getBinaryNodeChild(node, childTag)?.content
	if(Buffer.isBuffer(child) || child instanceof Uint8Array) {
		return child
	}
}

export const getBinaryNodeChildString = (node: BinaryNode | undefined, childTag: string) => {
	const child = getBinaryNodeChild(node, childTag)?.content
	if(Buffer.isBuffer(child) || child instanceof Uint8Array) {
		return Buffer.from(child).toString('utf-8')
	} else if(typeof child === 'string') {
		return child
	}
}

export const getBinaryNodeChildUInt = (node: BinaryNode, childTag: string, length: number) => {
	const buff = getBinaryNodeChildBuffer(node, childTag)
	if(buff) {
		return bufferToUInt(buff, length)
	}
}

export const getBinaryNodeFilter = (node) => {
   if(!Array.isArray(node)) return false
   
   return node.some(item => 
      ['native_flow'].includes(item?.content?.[0]?.content?.[0]?.tag) ||
      ['interactive', 'buttons', 'list'].includes(item?.content?.[0]?.tag) ||
      ['hsm', 'biz'].includes(item?.tag) ||
      ['bot'].includes(item?.tag) && item?.attrs?.biz_bot === '1'
   )
}

export const getAdditionalNode = (name: string) => {
   name = name.toLowerCase()
   
   const order_response_name = {
      review_and_pay: 'order_details',
      review_order: 'order_status',
      payment_info: 'payment_info',
      payment_status: 'payment_status',
      payment_method: 'payment_method'
   }
   
   const flow_name = {
      cta_catalog: 'cta_catalog',
      mpm: 'mpm',
      call_request: 'call_permission_request'
   }
   
   if(order_response_name[name]) {
      return [{
          tag: 'biz',
          attrs: { 
             native_flow_name: order_response_name[name] 
          }
      }]
   } else if(flow_name[name] || name === 'interactive' || name === 'buttons') {
      return [{
         tag: 'biz',
         attrs: { },
         content: [{
            tag: 'interactive',
			   		attrs: {
				   	   type: 'native_flow',
			      	 v: '1'
						},
						content: [{
			   			 tag: 'native_flow',
			   			 attrs: { 
			   					name: flow_name[name] ?? 'mixed',
			   				  v: '9',
			   		   },
			   			 content: []
					  }]
         }]
      }]
   } else if(name === 'list') {
      return [{
         tag: 'biz',
         attrs: { },
         content: [{
            tag: 'list',
            attrs: { 
               v: '2',
               type: 'product_list'
            }
         }]
      }]
   } else if(name === 'bot') {
      return [{ 
				 tag: 'bot', 
			   attrs: { biz_bot: '1' }
	    }]
   } else {
      return []
   }
}

export const assertNodeErrorFree = (node: BinaryNode) => {
	const errNode = getBinaryNodeChild(node, 'error')
	if(errNode) {
		throw new Boom(errNode.attrs.text || 'Unknown error', { data: +errNode.attrs.code })
	}
}

export const reduceBinaryNodeToDictionary = (node: BinaryNode, tag: string) => {
	const nodes = getBinaryNodeChildren(node, tag)
	const dict = nodes.reduce(
		(dict, { attrs }) => {
			dict[attrs.name || attrs.config_code] = attrs.value || attrs.config_value
			return dict
		}, { } as { [_: string]: string }
	)
	return dict
}

export const getBinaryNodeMessages = ({ content }: BinaryNode) => {
	const msgs: proto.WebMessageInfo[] = []
	if(Array.isArray(content)) {
		for(const item of content) {
			if(item.tag === 'message') {
				msgs.push(proto.WebMessageInfo.decode(item.content as Buffer))
			}
		}
	}

	return msgs
}

function bufferToUInt(e: Uint8Array | Buffer, t: number) {
	let a = 0
	for(let i = 0; i < t; i++) {
		a = 256 * a + e[i]
	}

	return a
}

const tabs = (n: number) => '\t'.repeat(n)

export function binaryNodeToString(node: BinaryNode | BinaryNode['content'], i = 0) {
	if(!node) {
		return node
	}

	if(typeof node === 'string') {
		return tabs(i) + node
	}

	if(node instanceof Uint8Array) {
		return tabs(i) + Buffer.from(node).toString('hex')
	}

	if(Array.isArray(node)) {
		return node.map((x) => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n')
	}

	const children = binaryNodeToString(node.content, i + 1)

	const tag = `<${node.tag} ${Object.entries(node.attrs || {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}='${v}'`)
		.join(' ')}`

	const content: string = children ? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>'

	return tag + content
}