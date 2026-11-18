# Creature League (working title)

A creature-collecting game in two parts: a third-person Unreal Engine 5 world where you explore, catch and trade original creatures and watch stadium battles, and a companion web and phone app for fantasy leagues where you draft creatures and set 4v4 lineups.

The full design lives in the design doc. This repository holds the code.

## What's here

| Folder | Contents |
| --- | --- |
| `data/` | Game data: 8 elements and the type chart, 20 species, 64 moves, stadium layouts |
| `simulator/` | The C++17 battle simulator, its command-line tool `clsim`, and tests |
| `examples/` | A sample 4v4 battle setup |
| `docs/` | The replay format the league server and Unreal share |

Later steps add the web app (`app/`) and the Unreal project (`game/`).

## The battle simulator

One simulator decides every battle. The league server runs it at each weekly lock, and the Unreal stadium plays back the replay it writes. It never runs its own battle logic. The simulator is plain C++17 with no dependencies, and all battle math is integer math with a fixed random number generator. The same setup and seed give the same battle on every machine.

It covers:

- **Individuals:** each creature is rolled from its species with up to ±8% on every stat and its own attitude. That's how a league pool gets 3 different copies of each species.
- **Typing in four layers:** 8 elements, with dual elements multiplying, plus form (flier, swimmer, burrower, walker), size, and habitat and weather.
- **Stadium spots:** perch, rock cover, soft ground, shallows, open field and tall grass, each with its own rules, plus terrain that changes mid-battle (scorch, freeze).
- **4v4 rounds:** tactics, move plans, priority and speed order, stamina, cooldowns, status effects, shields, buffs, criticals and attitudes.
- **Move advice:** the one-tap recommended move plan, with each move labelled recommended, situational or risky.
- **Replay log:** a JSON document of every event, described in [docs/replay-format.md](docs/replay-format.md).

### Build and test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/simulator/cl_tests
```

### Try it

```sh
./build/simulator/clsim battle examples/battle_setup.json --summary   # readable play-by-play
./build/simulator/clsim battle examples/battle_setup.json             # full replay JSON
./build/simulator/clsim advise examples/battle_setup.json             # recommended move plans
./build/simulator/clsim roll stormlynx 42                             # roll one individual
./build/simulator/clsim species                                       # list the catalog
```

Run from the repository root, or pass `--data path/to/data` first.

## Balancing

Creatures, moves, the type chart and stadiums are all JSON in `data/`, so balancing never needs a code change. Run `cl_tests` after editing: it checks the data rules (2 to 5 moves per creature, every element strong against 2 and weak to 2, and so on), and it plays 400 random battles to catch anything that breaks or always wins.

Creature and move names are placeholders.
