// Script to check if WebRTC AudioProcessing is available
const fs = require("fs");
const path = require("path");

const webrtcInstallDir = path.join(__dirname, "webrtc-install");
const webrtcLibDir = path.join(webrtcInstallDir, "lib");
const webrtcIncludeDir = path.join(webrtcInstallDir, "include");

function checkWebRTC() {
  const hasLib =
    fs.existsSync(webrtcLibDir) &&
    (fs.existsSync(path.join(webrtcLibDir, "libaudioprocessing.a")) ||
      fs.existsSync(path.join(webrtcLibDir, "libaudioprocessing.dylib")) ||
      fs.existsSync(path.join(webrtcLibDir, "audioprocessing.lib")));

  const hasInclude =
    fs.existsSync(webrtcIncludeDir) &&
    fs.existsSync(
      path.join(
        webrtcIncludeDir,
        "modules",
        "audio_processing",
        "include",
        "audio_processing.h"
      )
    );

  return hasLib && hasInclude;
}

if (require.main === module) {
  const available = checkWebRTC();
  console.log(available ? "YES" : "NO");
  process.exit(available ? 0 : 1);
}

module.exports = {
  checkWebRTC,
  webrtcInstallDir,
  webrtcLibDir,
  webrtcIncludeDir,
};
