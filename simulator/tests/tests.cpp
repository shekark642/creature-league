// Self-contained test runner (no external framework, so the repo builds anywhere).
#include <cstdio>
#include <functional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "cl/battle.hpp"
#include "cl/catalog.hpp"
#include "cl/rng.hpp"

using namespace cl;

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                                 \
    do {                                                                            \
        ++g_checks;                                                                 \
        if (!(cond)) {                                                              \
            ++g_failures;                                                           \
            std::printf("    FAILED %s:%d: %s\n", __FILE__, __LINE__, #cond);       \
        }                                                                           \
    } while (0)

#define CHECK_THROWS(expr)                                                          \
    do {                                                                            \
        ++g_checks;                                                                 \
        bool threw = false;                                                         \
        try { expr; } catch (const std::exception&) { threw = true; }               \
        if (!threw) {                                                               \
            ++g_failures;                                                           \
            std::printf("    FAILED %s:%d: expected throw: %s\n", __FILE__, __LINE__, #expr); \
        }                                                                           \
    } while (0)

const Catalog& catalog() {
    static const Catalog c = Catalog::load(CL_DATA_DIR);
    return c;
}

BattleSetup exampleSetup() {
    return BattleSetup::fromJson(catalog(), Json::parse(readFile(std::string(CL_EXAMPLES_DIR) + "/battle_setup.json")));
}

// A random but legal 4v4 setup, used for the stress test.
BattleSetup randomSetup(uint64_t seed) {
    const Catalog& cat = catalog();
    Rng rng(seed);
    std::vector<std::string> ids;
    for (const auto& kv : cat.allSpecies()) ids.push_back(kv.first);
    const Stadium& st = cat.stadium("riverside_arena");
    BattleSetup s;
    s.stadiumId = st.id;
    s.seed = seed;
    const Weather weathers[] = {Weather::Clear, Weather::Rain, Weather::Sun, Weather::Snow, Weather::Storm};
    s.weather = weathers[rng.below(5)];
    for (int t = 0; t < 2; ++t) {
        s.teams[t].name = t == 0 ? "Home" : "Away";
        std::set<std::pair<int, int>> used;
        while (static_cast<int>(s.teams[t].members.size()) < kTeamSize) {
            const std::string& sp = ids[rng.below(ids.size())];
            const Species& species = cat.species(sp);
            // Find a free spot this creature may stand on.
            std::vector<std::pair<int, int>> options;
            for (int c = 0; c < 2; ++c)
                for (int r = 0; r < 3; ++r)
                    if (!used.count({c, r}) && canStandOn(species, st.spots[c][r])) options.push_back({c, r});
            if (options.empty()) continue;
            auto spot = options[rng.below(options.size())];
            used.insert(spot);
            Placement p;
            p.creature = rollIndividual(cat, sp, rng.next());
            p.col = spot.first;
            p.row = spot.second;
            p.tactic = static_cast<Tactic>(rng.below(4));
            s.teams[t].members.push_back(p);
        }
    }
    return s;
}

void testDataLoads() {
    const Catalog& cat = catalog();
    CHECK(cat.allSpecies().size() == 20);
    CHECK(cat.allMoves().size() == 64);
    CHECK(cat.allStadiums().size() >= 1);
    for (const auto& kv : cat.allSpecies()) {
        const Species& s = kv.second;
        CHECK(s.moves.size() >= 2 && s.moves.size() <= 5);
        CHECK(s.elements.size() == 1 || s.elements.size() == 2);
        for (const std::string& m : s.moves) CHECK(cat.allMoves().count(m) == 1);
        // Every species must be able to stand somewhere on the stadium's 6 spots.
        int legal = 0;
        for (const auto& col : cat.stadium("riverside_arena").spots)
            for (SpotType spot : col) legal += canStandOn(s, spot) ? 1 : 0;
        CHECK(legal >= 4);
    }
}

void testTypeChartShape() {
    const TypeChart& tc = catalog().types();
    const int n = static_cast<int>(Element::Count);
    for (int a = 0; a < n; ++a) {
        int strong = 0, weak = 0;
        for (int d = 0; d < n; ++d) {
            int m = tc.vs(static_cast<Element>(a), static_cast<Element>(d));
            if (m == tc.strongPermille) ++strong;
            if (m == tc.weakPermille) ++weak;
            // No pair counters each other both ways.
            if (m == tc.strongPermille) CHECK(tc.vs(static_cast<Element>(d), static_cast<Element>(a)) == tc.weakPermille);
        }
        CHECK(strong == 2);
        CHECK(weak == 2);
        CHECK(tc.vs(static_cast<Element>(a), static_cast<Element>(a)) == 1000);
    }
}

void testDualElementMultiplier() {
    const TypeChart& tc = catalog().types();
    // From the design doc: a Grove move into a Tide/Stone creature does 1.5 x 1.5 = 2.25x.
    CHECK(tc.vs(Element::Grove, std::vector<Element>{Element::Tide, Element::Stone}) == 2250);
    CHECK(tc.vs(Element::Ember, std::vector<Element>{Element::Grove}) == 1500);
    CHECK(tc.vs(Element::Ember, std::vector<Element>{Element::Tide}) == 667);
    CHECK(tc.weather(Weather::Rain, Element::Tide) == 1150);
    CHECK(tc.weather(Weather::Rain, Element::Ember) == 850);
    CHECK(tc.weather(Weather::Clear, Element::Volt) == 1000);
}

void testIndividualRolls() {
    const Catalog& cat = catalog();
    for (const auto& kv : cat.allSpecies()) {
        const Species& s = kv.second;
        for (uint64_t seed = 1; seed <= 25; ++seed) {
            Individual ind = rollIndividual(cat, s.id, seed);
            auto within = [](int value, int base) {
                return value * 1000 >= base * (1000 - kRollPermille) - 1000 && value * 1000 <= base * (1000 + kRollPermille) + 1000;
            };
            CHECK(within(ind.stats.hp, s.base.hp));
            CHECK(within(ind.stats.attack, s.base.attack));
            CHECK(within(ind.stats.defense, s.base.defense));
            CHECK(within(ind.stats.focus, s.base.focus));
            CHECK(within(ind.stats.speed, s.base.speed));
        }
    }
    // Same seed, same creature; different seeds, (almost always) different creatures.
    Individual a = rollIndividual(cat, "thornelk", 7), b = rollIndividual(cat, "thornelk", 7), c = rollIndividual(cat, "thornelk", 8);
    CHECK(a.toJson().dump() == b.toJson().dump());
    CHECK(a.toJson().dump() != c.toJson().dump());
}

void testThreeCopiesDiffer() {
    // A league pool holds 3 individuals per species; their rolls should differ.
    const Catalog& cat = catalog();
    std::set<std::string> rolls;
    for (int copy = 0; copy < 3; ++copy)
        rolls.insert(rollIndividual(cat, "stormlynx", Rng::mix(42, static_cast<uint64_t>(copy))).toJson().at("stats").dump());
    CHECK(rolls.size() == 3);
}

void testSpotAndFormRules() {
    const Catalog& cat = catalog();
    const Species& falcon = cat.species("skyreave");
    const Species& bear = cat.species("bramblebear");
    const Species& hedgehog = cat.species("sporeling");
    CHECK(canStandOn(falcon, SpotType::Perch));
    CHECK(!canStandOn(bear, SpotType::Perch));
    CHECK(!canStandOn(bear, SpotType::Cover));       // huge creatures can't use cover
    CHECK(canStandOn(hedgehog, SpotType::Cover));

    const Move& quake = cat.move("quake_stomp");      // ground wave
    CHECK(!canBeHitBy(quake, falcon, SpotType::Perch));
    CHECK(canBeHitBy(quake, bear, SpotType::OpenField));

    const Move& jet = cat.move("jet_lash");           // long, single, not contact
    const Move& cloud = cat.move("spore_cloud");      // burst area
    CHECK(!canBeHitBy(jet, hedgehog, SpotType::SoftGround));   // dug in
    CHECK(canBeHitBy(cloud, hedgehog, SpotType::SoftGround));  // area moves still land
    CHECK(canBeHitBy(jet, hedgehog, SpotType::TallGrass));     // not dug in elsewhere

    const Move& snap = cat.move("thunder_snap");      // melee
    CHECK(reachOf(snap, bear, SpotType::TallGrass) == 1);
    CHECK(reachOf(snap, bear, SpotType::OpenField) == 2);
    CHECK(reachOf(snap, falcon, SpotType::Perch) == 2);
}

void testValidation() {
    const Catalog& cat = catalog();
    BattleSetup ok = exampleSetup();
    validateSetup(cat, ok);  // must not throw

    BattleSetup s = ok;
    s.teams[0].members.pop_back();
    CHECK_THROWS(validateSetup(cat, s));  // only 3 creatures

    s = ok;
    s.teams[0].members[1].col = s.teams[0].members[0].col;
    s.teams[0].members[1].row = s.teams[0].members[0].row;
    CHECK_THROWS(validateSetup(cat, s));  // two on one spot

    s = ok;
    s.teams[0].members[1].col = 0;  // bramblebear onto the perch? first free the perch
    s.teams[0].members[0].col = 1;
    s.teams[0].members[0].row = 2;
    s.teams[0].members[1].row = 0;
    CHECK_THROWS(validateSetup(cat, s));  // a walker can't stand on a perch

    s = ok;
    s.teams[0].members[0].movePlan = {"magma_gulp"};
    CHECK_THROWS(validateSetup(cat, s));  // move the species doesn't know
}

void testDeterminism() {
    const Catalog& cat = catalog();
    BattleSetup s = exampleSetup();
    const std::string first = runBattle(cat, s).replay.dump();
    const std::string second = runBattle(cat, s).replay.dump();
    CHECK(first == second);
    s.seed += 1;
    CHECK(runBattle(cat, s).replay.dump() != first);
}

void testBattleShape() {
    const Catalog& cat = catalog();
    BattleResult r = runBattle(cat, exampleSetup());
    CHECK(r.winner == 0 || r.winner == 1);
    CHECK(r.rounds >= 1 && r.rounds <= kDefaultMaxRounds);
    const Json& events = r.replay.at("events");
    CHECK(events.size() > 2);
    CHECK(events[0].at("type").asString() == "round_start");
    CHECK(events[events.size() - 1].at("type").asString() == "battle_end");
    CHECK(r.replay.at("format").asString() == "creature-league-replay");
    CHECK(r.replay.at("teams").size() == 2);
    // The replay must round-trip through the parser unchanged (Unreal reads this file).
    CHECK(Json::parse(r.replay.dump(2)).dump() == r.replay.dump());
}

void testStress() {
    const Catalog& cat = catalog();
    int wins[2] = {0, 0};
    int knockouts = 0;
    for (uint64_t seed = 1; seed <= 400; ++seed) {
        BattleSetup s = randomSetup(seed);
        BattleResult r;
        bool ok = true;
        try { r = runBattle(cat, s); } catch (const std::exception& e) {
            ok = false;
            std::printf("    seed %llu threw: %s\n", static_cast<unsigned long long>(seed), e.what());
        }
        CHECK(ok);
        if (!ok) continue;
        CHECK(r.rounds <= s.maxRounds);
        wins[r.winner]++;
        if (r.reason == "knockout") ++knockouts;
    }
    std::printf("    400 random battles: home %d, away %d, knockouts %d\n", wins[0], wins[1], knockouts);
    CHECK(wins[0] > 100 && wins[1] > 100);  // neither side of the field is favoured
    CHECK(knockouts > 200);                 // most battles end by knockout, not the round limit
}

void testAdvice() {
    const Catalog& cat = catalog();
    BattleSetup s = exampleSetup();
    std::vector<Individual> opp;
    for (const Placement& p : s.teams[1].members) opp.push_back(p.creature);
    const Individual& bear = s.teams[0].members[1].creature;
    std::vector<MoveAdvice> advice = adviseMoves(cat, bear, opp, Weather::Clear);
    CHECK(advice.size() == cat.species("bramblebear").moves.size());
    // Friendly supports lead the plan because they only fire when needed.
    CHECK(cat.move(advice.front().moveId).target != Target::Foe);
    bool anyRecommended = false;
    for (const MoveAdvice& a : advice) anyRecommended |= a.label == Advice::Recommended;
    CHECK(anyRecommended);
}

}  // namespace

int main() {
    const std::vector<std::pair<const char*, std::function<void()>>> tests = {
        {"data loads", testDataLoads},
        {"type chart shape", testTypeChartShape},
        {"dual element multiplier", testDualElementMultiplier},
        {"individual rolls", testIndividualRolls},
        {"three copies differ", testThreeCopiesDiffer},
        {"spot and form rules", testSpotAndFormRules},
        {"setup validation", testValidation},
        {"determinism", testDeterminism},
        {"battle shape", testBattleShape},
        {"stress", testStress},
        {"move advice", testAdvice},
    };
    for (const auto& t : tests) {
        const int before = g_failures;
        std::printf("%s\n", t.first);
        try { t.second(); } catch (const std::exception& e) {
            ++g_failures;
            std::printf("    FAILED with exception: %s\n", e.what());
        }
        std::printf("  %s\n", g_failures == before ? "ok" : "FAILED");
    }
    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
