// HOST may be given with or without a scheme. A self-hosted instance is often
// plain http on a LAN address, and unconditionally prepending https:// there
// produced "https://http://192.168.x.x:7000/..." for the logo and background,
// so neither image loaded. Keep the scheme when one is supplied.
const HOST = process.env.HOST
  ? /^https?:\/\//i.test(process.env.HOST)
    ? process.env.HOST
    : `https://${process.env.HOST}`
  : "https://stremio.tomz.dev";

const BASE_PATH = "/aisearch";

module.exports = { HOST, BASE_PATH };
