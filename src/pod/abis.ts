// ABIs extracted verbatim from the production TapeOut PoD bundle
// (https://tapeout.net/pod/ main-*.js). Human-readable ethers v6 fragments.

export const MINING_ABI = [
  'function minerKey(address,uint256) pure returns (bytes32)',
  'function getMiner(bytes32) view returns (tuple(address circuits,uint64 circuitId,uint32 taskId,uint32 gateCount,uint32 stateCount,uint32 depth,uint64 area,uint32 mult,uint64 since,uint8 status,address registrant,uint32 nandBurn,uint32 latchBurn,uint64 bstar,uint64 bonus,bool optimal,uint64 commitBlock,uint64 firstUnusedId,uint64 stopBlock,uint128 verifWeight,uint128 unverWeight,uint256 debt))',
  'function pending(bytes32) view returns (uint256)',
  'function totalVerifWeight() view returns (uint256)',
  'function ceCount(uint32,address) view returns (uint256)',
  'function passesCounterexamples(address,uint256,uint32,uint32,uint256) view returns (bool)',
  'function totalUnverWeight() view returns (uint256)',
  'function minerCount() view returns (uint256)',
  'function taskCount() view returns (uint256)',
  'function verifMinerCount() view returns (uint256)',
  'function currentRate() view returns (uint256)',
  'function dailyEmission() view returns (uint256)',
  'function totalForgone() view returns (uint256)',
  'function totalMined() view returns (uint256)',
  'function UNVERIFIED_BPS() view returns (uint16)',
  'function sampleCountFor(uint32,uint32) view returns (uint32)',
  'function start(address,uint256,uint32,uint256,bytes[],bytes[],bytes32[][],bytes32) returns (bytes32)',
  'function claim(bytes32)',
  'function claimMany(bytes32[])',
  'function stop(bytes32)',
  'function arm(address,uint256)',
  'function armedAt(bytes32) view returns (uint64)',
  'function cachedDepth(address,uint256) view returns (bool cached,uint32 depth,uint32 live)',
  'function reclaim(bytes32)',
  'function challenge(bytes32,uint32,bytes,bytes,bytes32[])',
  'function commitDesign(address,bytes32)',
  'function designCommitment(address,address,bytes32,bytes32) pure returns (bytes32)',
  'function designCommits(address,bytes32) view returns (uint64 blockNumber,uint64 firstUnusedId)',
  'function STOP_COOLDOWN() view returns (uint256)',
  'function startTime() view returns (uint64)',
  'function OWNER_HEAD_START() view returns (uint256)',
  'function owner() view returns (address)',
]

export const LENS_ABI = [
  'function previewScore(address,uint256,uint32) view returns (uint256 verifWeight,uint256 unverWeight,uint256 h,uint64 bstar,uint64 bonus,bool optimal,uint32 samples,string reason)',
  'function pendingLive(bytes32) view returns (uint256)',
  'function dailyEmission() view returns (uint256)',
]

export const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
]

export const CIRCUIT_ABI = [
  'function circuitInfo(uint256) view returns (uint32,uint32,uint32,uint32)',
  'function eval(uint256,bytes) view returns (bytes)',
  'function step(uint256,bytes,bytes) view returns (bytes newState, bytes outputs)',
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
]

// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
