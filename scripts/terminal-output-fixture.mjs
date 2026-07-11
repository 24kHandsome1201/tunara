#!/usr/bin/env node
/* global Buffer, process */

import { once } from "node:events";

const BLOCK_BYTES = 64 * 1024;
const BLOCK_HEADER_BYTES = 32;
const MAX_BYTES = 512 * 1024 * 1024;
const REFERENCE = "TUNARA_M1_OK 中文 🐟 é 界 ┌─┐";

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

const bytes = Number(readArgument("--bytes"));
const nonce = readArgument("--nonce");
if (!Number.isSafeInteger(bytes) || bytes < BLOCK_BYTES || bytes > MAX_BYTES) {
  fail(`--bytes must be an integer between ${BLOCK_BYTES} and ${MAX_BYTES}`);
} else if (!nonce || !/^[a-zA-Z0-9_-]{1,64}$/.test(nonce)) {
  fail("--nonce must contain only letters, digits, underscore, or dash");
} else {
  await runFixture(bytes, nonce);
}

function blockHeader(index) {
  const text = `@TUNARA-M1:${index.toString(16).padStart(8, "0")}@`;
  return Buffer.from(text.padEnd(BLOCK_HEADER_BYTES, "-"), "ascii");
}

async function write(buffer) {
  if (process.stdout.write(buffer)) return;
  await once(process.stdout, "drain");
}

async function runFixture(totalBytes, fixtureNonce) {
  const blockCount = Math.ceil(totalBytes / BLOCK_BYTES);
  const prefix = Buffer.from("\x1b[?1049h\x1b[2J\x1b[H", "utf8");
  const pattern = Buffer.from(
    "\r\n"
      + "\x1b]0;Tunara M1 high output\x07"
      + "\x1b[1;38;2;68;211;162m粗体中文\x1b[0m "
      + "\x1b[3;34mANSI\x1b[0m 🐟 é 界 ┌─┐ "
      + "office -> ligature ffi != >= "
      + "\x1b[2K\rcheckpoint\x1b[1C✓\r\n",
    "utf8",
  );
  const suffix = Buffer.from(
    `\x1b[0m\x1b[?1049l\r\n\x1b[1;38;2;68;211;162m${REFERENCE}\x1b[0m\r\n`,
    "utf8",
  );

  await write(Buffer.from(`__TUNARA_M1_BEGIN_${fixtureNonce}__\n`, "ascii"));
  let written = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const size = Math.min(BLOCK_BYTES, totalBytes - written);
    const block = Buffer.alloc(size, 0x20);
    blockHeader(index).copy(block, 0, 0, Math.min(BLOCK_HEADER_BYTES, size));
    let cursor = Math.min(BLOCK_HEADER_BYTES, size);
    if (index === 0) {
      prefix.copy(block, cursor);
      cursor += prefix.length;
    }
    const bodyEnd = index === blockCount - 1 ? size - suffix.length : size;
    if (bodyEnd < cursor) throw new Error("fixture block is too small for control sequences");
    while (cursor + pattern.length <= bodyEnd) {
      pattern.copy(block, cursor);
      cursor += pattern.length;
    }
    block.fill(0x2e, cursor, bodyEnd);
    if (index === blockCount - 1) suffix.copy(block, bodyEnd);
    await write(block);
    written += size;
  }
  await write(Buffer.from(`\n__TUNARA_M1_END_${fixtureNonce}__ blocks=${blockCount}\n`, "ascii"));
}
