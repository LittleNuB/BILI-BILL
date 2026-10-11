export const MAX_FRAME_BYTES = 256 * 1024;
export function encode(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > MAX_FRAME_BYTES) throw Error('ACCEPTANCE_FRAME_SIZE');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export function receive(stream, onMessage, onError) {
  let buffer = Buffer.alloc(0), failed = false;
  const fail = error => { if (!failed) { failed = true; onError(error); } };
  stream.on('data', chunk => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME_BYTES) throw Error('ACCEPTANCE_FRAME_SIZE');
        if (buffer.length < size + 4) break;
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4, 4 + size)));
        buffer = buffer.subarray(4 + size);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('ACCEPTANCE_FRAME_FORMAT');
        onMessage(value);
      }
    } catch (error) { fail(error); }
  });
  stream.on('end', () => { if (buffer.length) fail(Error('ACCEPTANCE_FRAME_TRUNCATED')); });
  stream.on('error', fail);
}
