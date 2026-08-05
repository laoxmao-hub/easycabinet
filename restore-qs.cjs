const fs = require('fs');
let content = fs.readFileSync('src/screens/QuickScannerScreen.tsx', 'utf8');

// Remove ALL line breaks first to get clean one-line content
content = content.replace(/\r\n/g, '\n').replace(/\r/g, '');
content = content.replace(/\n/g, ' ');

// Now add proper line breaks
// After semicolons followed by common keywords
const keywords = 'import|export|const|let|var|function|if|else|for|while|return|class|switch|try|catch|finally|throw|new|await|async|interface|type|enum';
content = content.replace(new RegExp(`;\\s*(${keywords})`, 'g'), ';\n$1');

// After closing brace + semicolon patterns
content = content.replace(/\};/g, '};\n');
content = content.replace(/\}\)/g, '})\n');

// Fix import statements
content = content.replace(/import\s*\{/g, 'import {\n');
content = content.replace(/\}\s*from\s/g, '\n} from ');

// Fix function declarations
content = content.replace(/export\s+function/g, '\nexport function');
content = content.replace(/export\s+const/g, '\nexport const');

// Fix arrow functions inside JSX
content = content.replace(/\)\s*=>\s*\{/g, ') => {\n');

fs.writeFileSync('src/screens/QuickScannerScreen.tsx', content);
console.log('Done. Lines:', content.split('\n').length);
