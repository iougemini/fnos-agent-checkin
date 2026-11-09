#!/usr/bin/env node
// 生成 MASTER_KEY：32 字节随机数的标准 base64。
const bytes = crypto.getRandomValues(new Uint8Array(32));
let binary = '';
for (const b of bytes) binary += String.fromCharCode(b);
process.stdout.write(btoa(binary) + '\n');
