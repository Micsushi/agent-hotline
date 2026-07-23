const assert = require("assert/strict");
const test = require("node:test");

const { createNativeTts, parseMacosVoices } = require("../src/native-tts");

test("parseMacosVoices ranks researched local voices above novelty and online voices", () => {
  const voices = parseMacosVoices(`
Bad News            en_US    # Hello! My name is Bad News.
Samantha            en_US    # Hello! My name is Samantha.
Alex                en_US    # Hello! My name is Alex.
Ava Enhanced        en_US    # Hello! My name is Ava.
Siri Online         en_US    # Hello! My name is Siri.
Daniel              en_GB    # Hello! My name is Daniel.
`);

  assert.equal(voices[0].name, "Alex");
  assert.equal(voices[1].name, "Ava Enhanced");
  assert.equal(voices.at(-1).name, "Siri Online");
});

test("macOS native generation resolves blank voice to the best installed voice", async () => {
  const calls = [];
  const nativeTts = createNativeTts({
    platform: "darwin",
    tmpRoot: require("os").tmpdir(),
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (command === "say" && args[0] === "-v" && args[1] === "?") {
        return {
          stdout: "Siri Online         en_US    # Hello!\nSamantha Enhanced   en_US    # Hello!\n"
        };
      }
      if (command === "say") return { stdout: "" };
      if (command === "afconvert") {
        const fs = require("fs");
        const wavPath = args.at(-1);
        fs.writeFileSync(
          wavPath,
          Buffer.from(
            "RIFF$\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\xc0]\0\0\x80\xbb\0\0\x02\0\x10\0data\0\0\0\0",
            "binary"
          )
        );
        return { stdout: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  });

  const generated = await nativeTts.generateMacos({
    text: "Use the best installed voice.",
    voice: "",
    rate: 0.9
  });

  const sayPlayback = calls.find((call) => call.command === "say" && call.args.includes("-o"));
  assert.deepEqual(sayPlayback.args.slice(0, 2), ["-v", "Samantha Enhanced"]);
  assert.equal(generated.voice, "Samantha Enhanced");
});
