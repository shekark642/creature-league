// 4v4 stadium battles: setup, the deterministic simulation and the replay log.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "cl/catalog.hpp"
#include "cl/json.hpp"

namespace cl {

constexpr int kTeamSize = 4;
constexpr int kDefaultMaxRounds = 30;

struct Placement {
    Individual creature;
    int col = 1;  // 0 = back row, 1 = front row
    int row = 0;  // 0..2
    Tactic tactic = Tactic::Aggressive;
    std::vector<std::string> movePlan;  // order to try moves in; empty = recommended order
};

struct TeamSetup {
    std::string name;
    std::vector<Placement> members;  // exactly kTeamSize
};

struct BattleSetup {
    std::string stadiumId;
    std::optional<Weather> weather;  // defaults to the stadium's weather
    uint64_t seed = 0;
    int maxRounds = kDefaultMaxRounds;
    TeamSetup teams[2];

    static BattleSetup fromJson(const Catalog& catalog, const Json& j);
};

struct BattleResult {
    int winner = -1;      // 0 or 1
    std::string reason;   // "knockout", "round_limit" or "tiebreak"
    int rounds = 0;
    int hpPermille[2] = {0, 0};  // summed remaining HP share per team, out of 1000 per creature
    Json replay;          // full replay document (see docs/replay-format.md)
};

// Throws std::invalid_argument with a readable message when the setup breaks a rule.
void validateSetup(const Catalog& catalog, const BattleSetup& setup);

BattleResult runBattle(const Catalog& catalog, const BattleSetup& setup);

// ---- Rule helpers, exposed for tests and for tools such as the move advisor. ----

// Spots a creature may stand on: perches are for fliers, cover can't hold large or huge creatures.
bool canStandOn(const Species& species, SpotType spot);

// Whether a move can hit a creature at all (fliers dodge ground waves, dug-in burrowers dodge
// single-target and line attacks from range).
bool canBeHitBy(const Move& move, const Species& defender, SpotType defenderSpot);

// How many spots away a move reaches from a given spot.
int reachOf(const Move& move, const Species& user, SpotType userSpot);

// ---- Move advice: the one-tap "recommended plan" shown before a battle. ----

enum class Advice { Recommended, Situational, Risky };
const char* toString(Advice a);

struct MoveAdvice {
    std::string moveId;
    Advice label = Advice::Recommended;
    int score = 0;
};

// Scores a creature's moves against the opposing lineup and returns them in the suggested order.
std::vector<MoveAdvice> adviseMoves(const Catalog& catalog, const Individual& creature,
                                    const std::vector<Individual>& opponents, Weather weather);

}  // namespace cl
