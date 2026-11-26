'use strict';

// Describes the cacheable prefix of an external request without keeping its text: the system
// prompt as one short hash per paragraph and each tool as its name plus a definition hash.
// Comparing two shapes shows which paragraphs or tools changed between calls. XML-style tag
// names and plain ASCII headings are kept because they are AGY's own section labels.
const { createHash } = require('node:crypto');

const HEADING = /^#{1,4} [A-Za-z][A-Za-z0-9 _/-]{0,60}$/;
const TAG = /^<\/?([a-z][a-z0-9_-]{0,40})>/;

function digest(...values) {
  const hash = createHash('sha256');
  for (const value of values) hash.update(JSON.stringify(value ?? null)).update('\0');
  return hash.digest('hex').slice(0, 16);
}

function labelOf(paragraph) {
  const first = paragraph.trimStart().split('\n', 1)[0].trim();
  if (HEADING.test(first)) return first;
  return first.match(TAG)?.[0];
}

function systemSections(systemInstruction) {
  const text = (systemInstruction?.parts || []).map(part => part.text || '').join('\n\n');
  return text.split(/\n\s*\n/).filter(paragraph => paragraph.trim()).map(paragraph => {
    const section = { hash: digest(paragraph).slice(0, 8), length: paragraph.length };
    const label = labelOf(paragraph);
    if (label) section.label = label;
    return section;
  });
}

function toolList(tools) {
  return (tools || []).flatMap(group => group.functionDeclarations || [])
    .map(declaration => ({ name: declaration.name, hash: digest(declaration).slice(0, 8) }));
}

function prefixShape(request) {
  return {
    system: digest(request.systemInstruction),
    tools: digest(request.tools),
    systemSections: systemSections(request.systemInstruction),
    toolList: toolList(request.tools),
  };
}

module.exports = { prefixShape, digest };
