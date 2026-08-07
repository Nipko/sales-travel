import fs from 'fs';
import readline from 'readline';

async function main() {
  const path =
    'C:\\Users\\USER\\.gemini\\antigravity\\brain\\440abc7b-cffd-4e3b-bfdf-e9239899b32c\\.system_generated\\logs\\transcript.jsonl';

  if (!fs.existsSync(path)) {
    console.log(`File does not exist: ${path}`);
    return;
  }
  const fileStream = fs.createReadStream(path);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.includes('test-db.js')) {
      try {
        const parsed = JSON.parse(line);
        console.log(`\n=== STEP ${parsed.step_index} (${parsed.type}) ===`);
        console.log(`Cmd: ${parsed.tool_calls?.[0]?.Arguments?.CommandLine || ''}`);
        if (parsed.output) {
          console.log(`Output: ${parsed.output.substring(0, 1000)}`);
        } else {
          console.log(`Content: ${parsed.content?.substring(0, 500)}`);
        }
      } catch (e) {}
    }
  }
}

main().catch(console.error);
