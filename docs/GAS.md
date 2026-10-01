# Gas per action

Measured by `./scripts/e2e.sh`: the gas each transaction in the end-to-end story really used on a local chain
(including the 21,000 base and calldata). Spends carry a Groth16 proof, so their calldata is most of the difference
between steps. ETH cost at 1, 5 and 20 gwei; multiply by the ETH price for dollars.

Whoever submits pays the gas: for spends that's the courier, who recovers it through its fee.

| Step | Gas | ETH @ 1 gwei | ETH @ 5 gwei | ETH @ 20 gwei |
|---|---:|---:|---:|---:|
| zip: approve | 46,306 | 0.00004 | 0.00023 | 0.00092 |
| zip: deposit | 348,154 | 0.00034 | 0.00174 | 0.00696 |
| zip address: setKey | 45,389 | 0.00004 | 0.00022 | 0.00090 |
| send: rezip to a zip address | 724,414 | 0.00072 | 0.00362 | 0.01448 |
| send: zip link | 710,690 | 0.00071 | 0.00355 | 0.01421 |
| unzip: relay to an address | 495,979 | 0.00049 | 0.00247 | 0.00991 |
| merchant: approve stake | 46,306 | 0.00004 | 0.00023 | 0.00092 |
| merchant: register | 168,734 | 0.00016 | 0.00084 | 0.00337 |
| pay: merchant + sales tax | 544,148 | 0.00054 | 0.00272 | 0.01088 |
| speak: burn to be heard | 488,207 | 0.00048 | 0.00244 | 0.00976 |
| knock: burn at a door | 477,137 | 0.00047 | 0.00238 | 0.00954 |
| badge: lock from a note | 705,906 | 0.00070 | 0.00352 | 0.01411 |
| post: anonymous board | 294,460 | 0.00029 | 0.00147 | 0.00588 |
| poll: create from a note | 653,241 | 0.00065 | 0.00326 | 0.01306 |
| poll: anonymous vote | 379,137 | 0.00037 | 0.00189 | 0.00758 |
| unzip: held by the courier | 517,130 | 0.00051 | 0.00258 | 0.01034 |
| badge: unlock via courier | 367,541 | 0.00036 | 0.00183 | 0.00735 |

Generated 2026-09-28.
