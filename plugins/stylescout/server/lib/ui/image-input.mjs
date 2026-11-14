const fail=message=>Object.assign(new Error(message),{publicMessage:message,status:400})
export function imageBytes(value){
  if(typeof value!=='string'||value.length>7*1024*1024)throw fail('图片过大，请使用 5MB 以内的图片。')
  const match=value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
  if(!match)throw fail('请使用 PNG、JPEG 或 WebP 图片。')
  const bytes=Buffer.from(match[2],'base64'),type=match[1]
  const valid=type==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'
  if(!valid||bytes.length>5*1024*1024||bytes.length<24)throw fail('返回的图片无效或超过 5MB，请换一张图片。')
  return {bytes,type,mime:'image/'+type}
}
