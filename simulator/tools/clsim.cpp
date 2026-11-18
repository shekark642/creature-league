// clsim: command-line front end for the battle simulator.
//
//   clsim [--data DIR] battle SETUP.json [--seed N] [--summary]
//   clsim [--data DIR] advise SETUP.json
//   clsim [--data DIR] roll SPECIES SEED
//   clsim [--data DIR] species
//   clsim [--data DIR] pool SEED            (3 individuals per species, as JSON)
//   clsim [--data DIR] advise-json FILE|-   (move advice for many creatures, as JSON)
// Any FILE argument can be "-" to read from standard input (used by the league server).
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "cl/battle.hpp"
#include "cl/catalog.hpp"

using namespace cl;

namespace {

std::string readInput(const std::string& path) {
    if (path != "-") return readFile(path);
    std::string all, line;
    while (std::getline(std::cin, line)) all += line + "\n";
    return all;
}

Individual creatureFrom(const Catalog& cat, const Json& j) {
    return rollIndividual(cat, j.at("species").asString(), static_cast<uint64_t>(j.at("individualSeed").asInt()));
}

int usage() {
    std::cerr << "usage:\n"
                 "  clsim [--data DIR] battle SETUP.json [--seed N] [--summary]\n"
                 "  clsim [--data DIR] advise SETUP.json\n"
                 "  clsim [--data DIR] roll SPECIES SEED\n"
                 "  clsim [--data DIR] species\n"
                 "  clsim [--data DIR] pool SEED\n"
                 "  clsim [--data DIR] advise-json FILE|-\n";
    return 2;
}

void printSummary(const Catalog& cat, const BattleResult& r) {
    const Json& replay = r.replay;
    std::printf("%s vs %s at %s (%s)\n", replay.at("teams")[0].at("name").asString().c_str(),
                replay.at("teams")[1].at("name").asString().c_str(),
                replay.at("stadium").at("name").asString().c_str(), replay.at("weather").asString().c_str());
    std::map<std::string, std::string> names;
    for (size_t t = 0; t < 2; ++t)
        for (const Json& m : replay.at("teams")[t].at("members").asArray())
            names[m.at("uid").asString()] = m.at("uid").asString() + " " + m.at("name").asString();
    for (const Json& e : replay.at("events").asArray()) {
        const std::string type = e.at("type").asString();
        const int round = static_cast<int>(e.at("round").asInt());
        if (type == "round_start") {
            std::printf("-- round %d (%s)\n", round, e.at("weather").asString().c_str());
        } else if (type == "move") {
            std::printf("  %s uses %s", names[e.at("actor").asString()].c_str(), e.at("moveName").asString().c_str());
            for (const Json& t : e.at("targets").asArray()) {
                std::printf(" | %s", names[t.at("target").asString()].c_str());
                if (t.has("hit") && !t.at("hit").asBool()) { std::printf(" missed"); continue; }
                if (t.has("damage")) std::printf(" -%lld HP (%lld left)%s", static_cast<long long>(t.at("damage").asInt()),
                                                 static_cast<long long>(t.at("hpAfter").asInt()),
                                                 t.get("crit").isNull() || !t.at("crit").asBool() ? "" : " CRIT");
                if (t.has("status")) std::printf(" +%s", t.at("status").asString().c_str());
                if (t.has("healed")) std::printf(" +%lld HP", static_cast<long long>(t.at("healed").asInt()));
                if (t.has("shield")) std::printf(" shield %lld", static_cast<long long>(t.at("shield").asInt()));
                if (t.has("buff")) std::printf(" %s +%lld%%", t.at("buff").asString().c_str(), static_cast<long long>(t.at("pct").asInt()));
                if (t.has("weather")) std::printf(" weather -> %s", t.at("weather").asString().c_str());
            }
            std::printf("\n");
        } else if (type == "faint") {
            std::printf("  %s faints\n", names[e.at("actor").asString()].c_str());
        } else if (type == "tick") {
            std::printf("  %s takes %lld from %s\n", names[e.at("actor").asString()].c_str(),
                        static_cast<long long>(e.at("damage").asInt()), e.at("cause").asString().c_str());
        } else if (type == "reposition") {
            std::printf("  %s moves to %s\n", names[e.at("actor").asString()].c_str(), e.at("to").at("type").asString().c_str());
        } else if (type == "rest") {
            std::printf("  %s rests\n", names[e.at("actor").asString()].c_str());
        } else if (type == "distracted") {
            std::printf("  %s is distracted\n", names[e.at("actor").asString()].c_str());
        } else if (type == "terrain_change") {
            std::printf("  terrain: %s -> %s\n", e.at("from").asString().c_str(), e.at("to").asString().c_str());
        }
    }
    (void)cat;
    std::printf("Winner: %s (%s after %d rounds)\n", replay.at("result").at("winnerName").asString().c_str(),
                r.reason.c_str(), r.rounds);
}

}  // namespace

int main(int argc, char** argv) {
    std::vector<std::string> args(argv + 1, argv + argc);
    std::string dataDir = "data";
    if (args.size() >= 2 && args[0] == "--data") {
        dataDir = args[1];
        args.erase(args.begin(), args.begin() + 2);
    }
    if (args.empty()) return usage();

    try {
        const Catalog cat = Catalog::load(dataDir);
        const std::string cmd = args[0];

        if (cmd == "species") {
            for (const auto& kv : cat.allSpecies()) {
                const Species& s = kv.second;
                std::string els;
                for (Element e : s.elements) els += std::string(els.empty() ? "" : "/") + toString(e);
                std::printf("%-12s %-12s %-9s %-7s hp %3d atk %3d def %3d foc %3d spd %3d  moves %zu\n", s.id.c_str(),
                            els.c_str(), toString(s.form), toString(s.size), s.base.hp, s.base.attack, s.base.defense,
                            s.base.focus, s.base.speed, s.moves.size());
            }
            return 0;
        }

        if (cmd == "roll") {
            if (args.size() < 3) return usage();
            Individual ind = rollIndividual(cat, args[1], std::strtoull(args[2].c_str(), nullptr, 10));
            std::cout << ind.toJson().dump(2) << "\n";
            return 0;
        }

        if (cmd == "pool") {
            // Individual seeds stay below 2^53 so JavaScript can hold them exactly:
            // seed = poolSeed * 1000 + speciesIndex * 3 + copy.
            if (args.size() < 2) return usage();
            const uint64_t poolSeed = std::strtoull(args[1].c_str(), nullptr, 10);
            Json out = Json::array();
            uint64_t index = 0;
            for (const auto& kv : cat.allSpecies()) {
                for (uint64_t copy = 0; copy < 3; ++copy) {
                    const uint64_t seed = poolSeed * 1000 + index * 3 + copy;
                    Json j = rollIndividual(cat, kv.first, seed).toJson();
                    j.set("copy", static_cast<int>(copy + 1));
                    out.push(j);
                }
                ++index;
            }
            std::cout << out.dump() << "\n";
            return 0;
        }

        if (cmd == "advise-json") {
            if (args.size() < 2) return usage();
            const Json req = Json::parse(readInput(args[1]));
            const Weather w = req.has("weather") ? parseEnum<Weather>(req.at("weather").asString()) : Weather::Clear;
            std::vector<Individual> opp;
            for (const Json& o : req.at("opponents").asArray()) opp.push_back(creatureFrom(cat, o));
            Json out = Json::array();
            for (const Json& c : req.at("creatures").asArray()) {
                Individual ind = creatureFrom(cat, c);
                Json moves = Json::array();
                for (const MoveAdvice& a : adviseMoves(cat, ind, opp, w)) {
                    Json m = Json::object();
                    m.set("move", a.moveId).set("label", toString(a.label)).set("score", a.score);
                    moves.push(m);
                }
                Json entry = Json::object();
                entry.set("species", ind.speciesId).set("individualSeed", ind.seed).set("moves", moves);
                out.push(entry);
            }
            std::cout << out.dump() << "\n";
            return 0;
        }

        if (cmd == "battle" || cmd == "advise") {
            if (args.size() < 2) return usage();
            BattleSetup setup = BattleSetup::fromJson(cat, Json::parse(readInput(args[1])));
            bool summary = false, compact = false;
            for (size_t i = 2; i < args.size(); ++i) {
                if (args[i] == "--compact") { compact = true; continue; }
                if (args[i] == "--seed" && i + 1 < args.size()) setup.seed = std::strtoull(args[++i].c_str(), nullptr, 10);
                else if (args[i] == "--summary") summary = true;
            }
            if (cmd == "advise") {
                const Weather w = setup.weather ? *setup.weather : cat.stadium(setup.stadiumId).defaultWeather;
                for (int t = 0; t < 2; ++t) {
                    std::vector<Individual> opp;
                    for (const Placement& p : setup.teams[1 - t].members) opp.push_back(p.creature);
                    std::printf("%s\n", setup.teams[t].name.c_str());
                    for (const Placement& p : setup.teams[t].members) {
                        std::printf("  %s:", cat.species(p.creature.speciesId).name.c_str());
                        for (const MoveAdvice& a : adviseMoves(cat, p.creature, opp, w))
                            std::printf(" %s [%s]", cat.move(a.moveId).name.c_str(), toString(a.label));
                        std::printf("\n");
                    }
                }
                return 0;
            }
            BattleResult r = runBattle(cat, setup);
            if (summary) printSummary(cat, r);
            else std::cout << r.replay.dump(compact ? -1 : 2) << "\n";
            return 0;
        }
        return usage();
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
}
