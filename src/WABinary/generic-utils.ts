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

export const getBinaryNodeFilter = (node: BinaryNode[] | undefined) => {
   if(Array.isArray(node)) {
		  return node.filter((item) => {
         if(item?.tag === 'bot' && item?.attrs?.biz_bot === '1') {
            return false;
         } else if(item?.tag === 'biz' && item?.attrs?.native_flow_name === 'order_details') {
            return false;
         } else if(item?.tag === 'biz' && item?.attrs?.native_flow_name === 'order_status') {
            return false;
         } else if(item?.tag === 'biz' && item?.attrs?.native_flow_name === 'payment_info') {
            return false;
         } else if(item?.tag === 'biz' && item?.attrs?.native_flow_name === 'payment_status') {
            return false;
         } else if(item?.tag === 'biz' && item?.attrs?.native_flow_name === 'payment_method') {
            return false;
         } else if(item?.tag === 'biz') {
            return false;
         }
         return true;
      })
   } else {
      return node
 	 }
}


export const getAdditionalNode = (type: string) => {
   type = type.toLowerCase()
   if(type === 'interactive' || type === 'buttons') {
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
			   					name: 'mixed',
			   				  v: '9',
			   		   },
			   			 content: []
					  }]
         }]
      }]
   } else if(type === 'review_and_pay') {
      return [{
          tag: 'biz',
          attrs: { native_flow_name: 'order_details' }
      }]
   } else if(type === 'review_order') {
      return [{
          tag: 'biz',
          attrs: { native_flow_name: 'order_status' }
      }]
   } else if(type === 'payment_info') {
      return [{
          tag: 'biz',
          attrs: { native_flow_name: 'payment_info' }
      }]
   } else if(type === 'payment_status') {
      return [{
          tag: 'biz',
          attrs: { native_flow_name: 'payment_status' }
      }]
   } else if(type === 'payment_method') {
      return [{
          tag: 'biz',
          attrs: { native_flow_name: 'payment_method' }
      }]
   } else if(type === 'list') {
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
   } else if(type === 'bot') {
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