const fs = require('fs');
const content = fs.readFileSync('src/screens/PackingScreen.tsx', 'utf8');
const lines = content.split('\n');

let depth = 0;
let maxDepth = 0;
const events = [];

for (let i = 2529; i < 5010 && i < lines.length; i++) {
  const line = lines[i];
  const lineNum = i + 1;
  const opens = (line.match(/<div[\s>]/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  if (opens > 0 || closes > 0) {
    const oldDepth = depth;
    depth += opens;
    depth -= closes;
    if (depth < 0) {
      events.push(`NEGATIVE at line ${lineNum}: depth ${oldDepth} -> ${depth} (${opens} opens, ${closes} closes)`);
    }
    if (depth > maxDepth) maxDepth = depth;
    if (opens > 0 || closes > 0) {
      events.push(`L${lineNum}: depth ${oldDepth} -> ${depth} (+${opens}/-${closes}): ${line.trim().substring(0, 80)}`);
    }
  }
}

console.log('Final depth:', depth);
console.log('Max depth:', maxDepth);
console.log('Total events:', events.length);
console.log('\n--- All depth changes ---');
events.forEach(e => console.log(e));
