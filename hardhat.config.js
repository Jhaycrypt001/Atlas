/** Minimal Hardhat 3 config — only used to run a local EVM node for testing. */
export default {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: { type: "edr-simulated", chainId: 31337 },
  },
};
