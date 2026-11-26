'use strict';

const { randomBytes } = require('node:crypto');
const { generate } = require('./provider.cjs');

const readSample = {
  functionDeclarations: [{
    name: 'read_sample',
    description: 'Read the short text generated for this connection test.',
    parameters: { type: 'OBJECT', properties: {} },
  }],
};

async function probeTools(connection, signal) {
  const sample = `agy-probe-${randomBytes(8).toString('hex')}`;
  const initial = {
    contents: [{
      role: 'user',
      parts: [{ text: 'Call read_sample, then reply with the exact text returned by the tool.' }],
    }],
    tools: [readSample],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_sample'] } },
  };
  const firstParts = [];
  let firstFinish;
  await generate({
    connection,
    request: initial,
    signal,
    onChunk(chunk) {
      const candidate = chunk.candidates?.[0];
      firstParts.push(...(candidate?.content?.parts || []));
      if (candidate?.finishReason) firstFinish = candidate.finishReason;
    },
  });

  const calls = firstParts.filter((part) => part.functionCall).map((part) => part.functionCall);
  if (firstFinish !== 'STOP' || calls.length !== 1 || calls[0].name !== 'read_sample' ||
      Object.keys(calls[0].args).length) {
    return { ok: false, message: '模型未正确调用测试工具。' };
  }

  const request = {
    ...initial,
    contents: [
      ...initial.contents,
      { role: 'model', parts: firstParts },
      { role: 'user', parts: [{
        functionResponse: {
          id: calls[0].id,
          name: calls[0].name,
          response: { content: sample },
        },
      }] },
    ],
    toolConfig: { functionCallingConfig: { mode: 'NONE' } },
  };
  let output = '';
  let secondFinish;
  let extraCall = false;
  await generate({
    connection,
    request,
    signal,
    onChunk(chunk) {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (!part.thought && typeof part.text === 'string') output += part.text;
        if (part.functionCall) extraCall = true;
      }
      if (candidate?.finishReason) secondFinish = candidate.finishReason;
    },
  });
  if (secondFinish !== 'STOP' || extraCall || !output.includes(sample)) {
    return { ok: false, message: '模型未正确接收测试工具的结果。' };
  }
  return { ok: true, message: '工具调用和结果回传成功。' };
}

module.exports = { probeTools };
