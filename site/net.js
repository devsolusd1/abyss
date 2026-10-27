// Which cluster and program the site talks to. Loaded before vendor/chain.js, and read by it,
// so switching cluster needs no rebuild. `?net=devnet` or `?net=mainnet` on any page overrides
// the default for that view.
(function () {
  const NETS = {
    devnet: {
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      program: "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK",
      explorer: (what, id) => `https://explorer.solana.com/${what}/${id}?cluster=devnet`,
    },
    mainnet: {
      cluster: "mainnet",
      rpcUrl: "",
      program: "",
      explorer: (what, id) => `https://explorer.solana.com/${what}/${id}`,
    },
  };
  let pick = "devnet";
  try {
    const asked = new URLSearchParams(location.search).get("net");
    if (asked && NETS[asked]) pick = asked;
  } catch (e) {}
  const net = NETS[pick];
  net.ready = Boolean(net.rpcUrl && net.program);
  window.NET = net;
})();
