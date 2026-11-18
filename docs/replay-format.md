# Replay format

Every battle the simulator runs produces one replay document. The league server stores it, the app shows it as a text log, and the stadium in Unreal plays it back as a broadcast. The stadium never decides anything itself. It only animates what the replay says happened.

The same setup and seed always produce the same replay, byte for byte. All battle math is integer (permille) math with a fixed random number generator, so the C++ code gives identical results on the server and inside Unreal.

## Top level

| Field | Meaning |
| --- | --- |
| `format`, `version` | Always `"creature-league-replay"` and `1` for now |
| `seed` | The battle seed |
| `stadium` | `id`, `name` and the 6 `spots` (`col`, `row`, `type`) each side starts with |
| `weather` | Starting weather: `clear`, `rain`, `sun`, `snow` or `storm` |
| `maxRounds` | Round limit, 30 by default |
| `teams` | Two teams, each with a `name` and 4 `members` |
| `events` | Everything that happened, in order |
| `result` | `winner` (0 or 1), `winnerName`, `reason`, `rounds`, `hpPermille` |

Each team member has a `uid` (`A1` to `A4` for team 0, `B1` to `B4` for team 1), `name`, the rolled `individual` (stats and attitude), its starting `spot`, `tactic` and the `movePlan` it used.

## Coordinates

Each side has a 2 × 3 grid. `col` 0 is the back row and `col` 1 the front row, and `row` runs from 0 to 2. Distance between two creatures is counted in spots across the whole arena: front row to front row in the same lane is 1 (melee), and back row to back row is 3.

## Events

Every event has `round` and `type`. Creatures are referenced by `uid`.

| Type | Fields |
| --- | --- |
| `round_start` | `weather` |
| `move` | `actor`, `move`, `moveName`, `element`, `category`, `area`, `animation`, `camera`, `hype`, `staminaAfter`, `targets` |
| `reposition` | `actor`, `from`, `to` (each a spot with `side`, `col`, `row`, `type`) |
| `rest` | `actor`, `stamina`, `gained` |
| `distracted` | `actor` (a Wild-attitude creature wasted its turn) |
| `terrain_change` | `spot`, `from`, `to` (for example `tall_grass` to `scorched`) |
| `tick` | `actor`, `cause` (`burn`, `poison`, `scorched_ground`), `damage`, `hpAfter` |
| `faint` | `actor` |
| `battle_end` | `winner`, `reason` |

Each entry in a move's `targets` has `target` and, depending on the move:

- **Attacks:** `hit`, then on a hit `damage`, `typeModPermille` (1500 = strong, 667 = weak, 2250 = double strong), `crit`, optional `wildSurge` and `shieldAbsorbed`, optional `status` and `statusRounds`, and `hpAfter`.
- **Support:** `healed` and `hpAfter`, or `shield` and `shieldRounds`, or `buff`, `pct` and `rounds`, or `weather`.

`animation`, `camera` and `hype` (1 to 5) come from the move's presentation data and tell the stadium how to stage it.

## Example

```json
{"round": 2, "type": "move", "actor": "A1", "move": "stoop_strike", "moveName": "Stoop Strike",
 "element": "gale", "category": "strike", "area": "single", "animation": "stoop_strike",
 "camera": "slowmo", "hype": 5, "staminaAfter": 47,
 "targets": [{"target": "B3", "hit": true, "damage": 95, "typeModPermille": 1500, "crit": false, "hpAfter": 0}]}
```
