import { type Terminal } from "@xterm/xterm";

export function createTerminalOutputBuffer(term: Terminal) {
  let pendingData: Uint8Array[] = [];
  let writeRafId = 0;

  const flush = () => {
    writeRafId = 0;
    if (pendingData.length === 1) {
      term.write(pendingData[0]);
    } else if (pendingData.length > 1) {
      let totalLen = 0;
      for (const data of pendingData) totalLen += data.length;
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const data of pendingData) {
        merged.set(data, offset);
        offset += data.length;
      }
      term.write(merged);
    }
    pendingData = [];
  };

  return {
    push(data: Uint8Array) {
      pendingData.push(data);
      if (!writeRafId) writeRafId = requestAnimationFrame(flush);
    },
    dispose() {
      if (writeRafId) cancelAnimationFrame(writeRafId);
      writeRafId = 0;
      pendingData = [];
    },
  };
}
