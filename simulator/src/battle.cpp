#include "cl/battle.hpp"

#include <algorithm>
#include <cstdlib>
#include <map>
#include <set>
#include <stdexcept>

#include "cl/rng.hpp"

namespace cl {

// ---------------------------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------------------------

bool canStandOn(const Species& species, SpotType spot) {
    if (spot == SpotType::Perch) return species.form == Form::Flier;
    if (spot == SpotType::Cover) return species.size != Size::Large && species.size != Size::Huge;
    return true;
}

bool canBeHitBy(const Move& move, const Species& defender, SpotType defenderSpot) {
    if (move.groundWave && defender.form == Form::Flier) return false;
    const bool dugIn = defender.form == Form::Burrower && defenderSpot == SpotType::SoftGround;
    if (dugIn) {
        const bool areaMove = move.area == Area::Burst || move.area == Area::Field;
        const bool closeContact = move.contact && move.range == Range::Melee;
        if (!areaMove && !closeContact) return false;
    }
    return true;
}

int reachOf(const Move& move, const Species& user, SpotType userSpot) {
    int reach = 0;
    switch (move.range) {
        case Range::Self: return 0;
        case Range::Melee: reach = 1; break;
        case Range::Mid: reach = 2; break;
        case Range::Long: return 99;
    }
    if (userSpot == SpotType::OpenField) reach += 1;
    if (userSpot == SpotType::Perch && user.form == Form::Flier) reach += 1;
    return reach;
}

const char* toString(Advice a) {
    switch (a) {
        case Advice::Recommended: return "recommended";
        case Advice::Situational: return "situational";
        case Advice::Risky: return "risky";
    }
    return "?";
}

namespace {

bool habitatMatches(Habitat h, SpotType s) {
    switch (s) {
        case SpotType::Perch: return h == Habitat::Alpine;
        case SpotType::Cover: return h == Habitat::Alpine || h == Habitat::Coast;
        case SpotType::SoftGround: return h == Habitat::Forest || h == Habitat::Wetland;
        case SpotType::Shallows: return h == Habitat::River || h == Habitat::Coast || h == Habitat::Wetland;
        case SpotType::OpenField: return false;
        case SpotType::TallGrass: return h == Habitat::Forest || h == Habitat::Wetland;
        case SpotType::Scorched: return h == Habitat::Volcanic;
    }
    return false;
}

bool isSupportOnFriends(const Move& m) {
    return m.target == Target::Self || m.target == Target::Ally || m.target == Target::Allies;
}

int areaBonusPermille(Area a) {
    switch (a) {
        case Area::Line: case Area::Cone: return 1200;
        case Area::Burst: return 1300;
        case Area::Field: return 1500;
        default: return 1000;
    }
}

}  // namespace

std::vector<MoveAdvice> adviseMoves(const Catalog& catalog, const Individual& creature,
                                    const std::vector<Individual>& opponents, Weather weather) {
    const Species& sp = catalog.species(creature.speciesId);
    std::vector<MoveAdvice> supports, attacks;
    for (const std::string& id : sp.moves) {
        const Move& m = catalog.move(id);
        MoveAdvice a;
        a.moveId = id;
        if (isSupportOnFriends(m)) {
            // Friendly support moves only fire when needed, so they lead the plan.
            a.label = Advice::Situational;
            a.score = 0;
            supports.push_back(a);
            continue;
        }
        // Average type multiplier across the opponents this move can actually hit.
        int64_t sum = 0;
        int hittable = 0;
        for (const Individual& o : opponents) {
            const Species& os = catalog.species(o.speciesId);
            if (m.groundWave && os.form == Form::Flier) continue;
            int64_t mult = catalog.types().vs(m.element, os.elements);
            if (os.form == Form::Flier && (m.element == Element::Volt || m.element == Element::Gale)) mult = mult * 1250 / 1000;
            sum += mult;
            ++hittable;
        }
        const int avg = hittable ? static_cast<int>(sum / hittable) : 0;
        const int stat = m.category == Category::Strike ? creature.stats.attack : creature.stats.focus;
        int64_t power = m.dealsDamage() ? m.power : 40;  // status-only moves get a modest flat value
        if (m.hasFlag("doubleInRain") && weather == Weather::Rain) power *= 2;
        int64_t score = power * m.accuracy / 100;
        score = score * avg / 1000;
        score = score * catalog.types().weather(weather, m.element) / 1000;
        score = score * areaBonusPermille(m.area) / 1000;
        score = score * stat / 100;
        a.score = static_cast<int>(score);
        const bool mostlyImmune = !opponents.empty() && hittable * 2 < static_cast<int>(opponents.size());
        if (m.accuracy < 85) a.label = Advice::Risky;
        else if (!m.dealsDamage() || avg < 1000 || mostlyImmune) a.label = Advice::Situational;
        else a.label = Advice::Recommended;
        attacks.push_back(a);
    }
    std::stable_sort(attacks.begin(), attacks.end(),
                     [](const MoveAdvice& x, const MoveAdvice& y) { return x.score > y.score; });
    supports.insert(supports.end(), attacks.begin(), attacks.end());
    return supports;
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

BattleSetup BattleSetup::fromJson(const Catalog& catalog, const Json& j) {
    BattleSetup s;
    s.stadiumId = j.at("stadium").asString();
    if (j.has("weather")) s.weather = parseEnum<Weather>(j.at("weather").asString());
    s.seed = static_cast<uint64_t>(j.at("seed").asInt());
    if (j.has("maxRounds")) s.maxRounds = static_cast<int>(j.at("maxRounds").asInt());
    const Json& teams = j.at("teams");
    if (teams.size() != 2) throw std::invalid_argument("a battle needs exactly 2 teams");
    for (int t = 0; t < 2; ++t) {
        const Json& tj = teams[t];
        s.teams[t].name = tj.at("name").asString();
        int i = 0;
        for (const Json& mj : tj.at("members").asArray()) {
            Placement p;
            const std::string speciesId = mj.at("species").asString();
            const uint64_t indSeed = static_cast<uint64_t>(mj.at("individualSeed").asInt());
            p.creature = rollIndividual(catalog, speciesId, indSeed,
                                        mj.has("id") ? mj.at("id").asString()
                                                     : std::string(1, static_cast<char>('A' + t)) + std::to_string(i + 1));
            p.col = static_cast<int>(mj.at("spot").at("col").asInt());
            p.row = static_cast<int>(mj.at("spot").at("row").asInt());
            p.tactic = parseEnum<Tactic>(mj.get("tactic").isNull() ? "aggressive" : mj.at("tactic").asString());
            if (mj.has("movePlan"))
                for (const Json& m : mj.at("movePlan").asArray()) p.movePlan.push_back(m.asString());
            s.teams[t].members.push_back(p);
            ++i;
        }
    }
    return s;
}

void validateSetup(const Catalog& catalog, const BattleSetup& setup) {
    auto fail = [](const std::string& m) { throw std::invalid_argument(m); };
    const Stadium* stadium = nullptr;
    try { stadium = &catalog.stadium(setup.stadiumId); } catch (const std::exception& e) { fail(e.what()); }
    if (setup.maxRounds < 1 || setup.maxRounds > 200) fail("maxRounds must be between 1 and 200");
    for (int t = 0; t < 2; ++t) {
        const TeamSetup& team = setup.teams[t];
        if (static_cast<int>(team.members.size()) != kTeamSize)
            fail("team '" + team.name + "' must field exactly " + std::to_string(kTeamSize) + " creatures");
        std::set<std::pair<int, int>> used;
        for (const Placement& p : team.members) {
            const Species* sp = nullptr;
            try { sp = &catalog.species(p.creature.speciesId); } catch (const std::exception& e) { fail(e.what()); }
            if (p.col < 0 || p.col > 1 || p.row < 0 || p.row > 2)
                fail(sp->name + " is placed outside the stadium grid");
            if (!used.insert({p.col, p.row}).second)
                fail("team '" + team.name + "' places two creatures on the same spot");
            const SpotType spot = stadium->spots[p.col][p.row];
            if (!canStandOn(*sp, spot))
                fail(sp->name + " can't stand on a " + toString(spot) + " spot");
            for (const std::string& m : p.movePlan)
                if (std::find(sp->moves.begin(), sp->moves.end(), m) == sp->moves.end())
                    fail(sp->name + " doesn't know the move '" + m + "'");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

namespace {

struct Status {
    int rounds = 0;
    int value = 0;
    bool active() const { return rounds > 0; }
};

struct Buff {
    Stat stat;
    int pct;
    int rounds;
};

struct Unit {
    int side = 0, index = 0;
    std::string uid;
    Individual ind;
    const Species* sp = nullptr;
    int col = 0, row = 0;
    Tactic tactic = Tactic::Aggressive;
    std::vector<const Move*> plan;
    int hp = 0, maxHp = 0, stamina = 0, maxStamina = 0;
    std::map<std::string, int> cooldown;
    Status burn, poison, snare, slow, blind;
    std::vector<Buff> buffs;
    int shield = 0, shieldRounds = 0;
    bool fainted = false;

    int hpPermille() const { return maxHp ? hp * 1000 / maxHp : 0; }
    int buffPct(Stat s) const {
        int p = 0;
        for (const Buff& b : buffs) if (b.stat == s) p += b.pct;
        return p;
    }
    bool hasBuff(Stat s) const {
        for (const Buff& b : buffs) if (b.stat == s) return true;
        return false;
    }
};

constexpr int kDoubleKnockout = -2;

struct Action {
    enum Kind { UseMove, Reposition, Rest } kind = Rest;
    const Move* move = nullptr;
    Unit* target = nullptr;
    int toCol = 0, toRow = 0;
};

class Battle {
public:
    Battle(const Catalog& catalog, const BattleSetup& setup)
        : cat_(catalog), setup_(setup), stadium_(catalog.stadium(setup.stadiumId)), rng_(setup.seed) {
        weather_ = setup.weather ? *setup.weather : stadium_.defaultWeather;
        for (int s = 0; s < 2; ++s) spots_[s] = stadium_.spots;
        for (int s = 0; s < 2; ++s) {
            std::vector<Individual> opponents;
            for (const Placement& p : setup.teams[1 - s].members) opponents.push_back(p.creature);
            for (int i = 0; i < kTeamSize; ++i) {
                const Placement& p = setup.teams[s].members[i];
                Unit u;
                u.side = s;
                u.index = i;
                u.uid = std::string(1, static_cast<char>('A' + s)) + std::to_string(i + 1);
                u.ind = p.creature;
                u.sp = &catalog.species(p.creature.speciesId);
                u.col = p.col;
                u.row = p.row;
                u.tactic = p.tactic;
                std::vector<std::string> plan = p.movePlan;
                if (plan.empty())
                    for (const MoveAdvice& a : adviseMoves(catalog, p.creature, opponents, weather_)) plan.push_back(a.moveId);
                for (const std::string& m : plan) u.plan.push_back(&catalog.move(m));
                u.maxHp = u.hp = p.creature.stats.hp;
                u.maxStamina = u.stamina = p.creature.stats.stamina;
                units_.push_back(u);
            }
        }
    }

    BattleResult run() {
        Json events = Json::array();
        events_ = &events;
        int round = 0;
        int winner = -1;
        std::string reason;
        while (round < setup_.maxRounds) {
            ++round;
            round_ = round;
            emit(event("round_start").set("weather", toString(weather_)));
            playRound();
            winner = knockoutWinner();
            if (winner != -1) break;
            endOfRound();
            winner = knockoutWinner();
            if (winner != -1) break;
        }
        if (winner >= 0) reason = "knockout";
        BattleResult r;
        for (const Unit& u : units_) r.hpPermille[u.side] += u.hpPermille();
        if (winner == kDoubleKnockout) {
            // Both teams fell to end-of-round damage at once: a coin flip from the seed decides.
            winner = static_cast<int>(rng_.below(2));
            reason = "double_knockout";
        } else if (winner < 0) {
            if (r.hpPermille[0] != r.hpPermille[1]) {
                winner = r.hpPermille[0] > r.hpPermille[1] ? 0 : 1;
                reason = "round_limit";
            } else {
                winner = static_cast<int>(rng_.below(2));
                reason = "tiebreak";
            }
        }
        r.winner = winner;
        r.reason = reason;
        r.rounds = round;
        Json result = Json::object();
        result.set("winner", winner).set("winnerName", setup_.teams[winner].name).set("reason", reason)
            .set("rounds", round).set("hpPermille", Json(Json::Array{r.hpPermille[0], r.hpPermille[1]}));
        round_ = round;
        emit(event("battle_end").set("winner", winner).set("reason", reason));
        r.replay = header();
        r.replay.set("events", events).set("result", result);
        return r;
    }

private:
    // ---- geometry ----
    static int xOf(int side, int col) { return side == 0 ? col : 3 - col; }
    static int distance(const Unit& a, const Unit& b) {
        return std::abs(xOf(a.side, a.col) - xOf(b.side, b.col)) + std::abs(a.row - b.row);
    }
    SpotType spotOf(const Unit& u) const { return spots_[u.side][u.col][u.row]; }

    // ---- derived stats ----
    int stat(const Unit& u, Stat s) const {
        int base = 0;
        switch (s) {
            case Stat::Attack: base = u.ind.stats.attack; break;
            case Stat::Defense: base = u.ind.stats.defense; break;
            case Stat::Focus: base = u.ind.stats.focus; break;
            case Stat::Speed: base = u.ind.stats.speed; break;
            default: return 0;
        }
        int m = 1000 + u.buffPct(s) * 10;
        if (u.ind.attitude == Attitude::Bold) {
            if (s == Stat::Attack) m += 100;
            if (s == Stat::Defense) m -= 100;
        }
        if (u.ind.attitude == Attitude::Loyal && s == Stat::Defense) {
            for (const Unit& o : units_)
                if (o.side == u.side && !o.fainted && &o != &u && o.hp * 4 < o.maxHp) { m += 100; break; }
        }
        if (s == Stat::Speed && u.slow.active()) m -= u.slow.value * 10;
        const SpotType spot = spotOf(u);
        if (habitatMatches(u.sp->habitat, spot)) m += 100;
        if (u.sp->form == Form::Swimmer) {
            if (spot == SpotType::Shallows) m += 200;
            else if (s == Stat::Speed) m -= 200;
        }
        m = std::max(m, 200);
        return static_cast<int>(static_cast<int64_t>(base) * m / 1000);
    }

    int evasion(const Unit& u) const {
        int e = u.ind.hidden.evasionPermille + u.buffPct(Stat::Evasion) * 10;
        if (u.ind.attitude == Attitude::Timid) e += 150;
        if (spotOf(u) == SpotType::TallGrass) e += 150;
        if (u.snare.active()) e /= 2;
        return std::clamp(e, 0, 600);
    }

    // ---- targeting ----
    bool canHit(const Unit& user, const Move& m, const Unit& t) const {
        if (t.fainted || t.side == user.side) return false;
        if (!canBeHitBy(m, *t.sp, spotOf(t))) return false;
        if (m.area == Area::Field) return true;
        return distance(user, t) <= reachOf(m, *user.sp, spotOf(user));
    }

    std::vector<Unit*> foeTargets(const Unit& user, const Move& m) {
        std::vector<Unit*> out;
        for (Unit& t : units_) if (canHit(user, m, t)) out.push_back(&t);
        return out;
    }

    Unit* pickFoe(const Unit& user, const std::vector<Unit*>& cands) {
        Unit* best = nullptr;
        auto better = [&](const Unit* a, const Unit* b) {
            switch (user.tactic) {
                case Tactic::Aggressive: return a->hpPermille() < b->hpPermille();
                case Tactic::Guardian: return stat(*a, Stat::Attack) > stat(*b, Stat::Attack);
                case Tactic::Disruptor: return stat(*a, Stat::Speed) > stat(*b, Stat::Speed);
                case Tactic::Skirmisher:
                    if (a->col != b->col) return a->col < b->col;  // back row first
                    return stat(*a, Stat::Defense) < stat(*b, Stat::Defense);
            }
            return false;
        };
        for (Unit* c : cands) if (!best || better(c, best)) best = c;
        return best;
    }

    bool needsSelfSupport(const Unit& u, const Move& m) const {
        switch (m.effect.type) {
            case EffectType::Heal: return u.hp * 100 < u.maxHp * 60;
            case EffectType::Shield: return u.shield == 0 && u.hp * 100 < u.maxHp * 85;
            case EffectType::Buff: return !u.hasBuff(m.effect.stat);
            case EffectType::Weather: return weather_ != m.effect.weather;
            default: return false;
        }
    }

    Action choose(Unit& u) {
        Action a;
        for (const Move* m : u.plan) {
            if (u.cooldown[m->id] > 0 || u.stamina < m->staminaCost) continue;
            if (m->target == Target::Self) {
                if (needsSelfSupport(u, *m)) { a.kind = Action::UseMove; a.move = m; a.target = &u; return a; }
                continue;
            }
            if (m->target == Target::Allies) {
                bool need = false;
                for (const Unit& o : units_)
                    if (o.side == u.side && !o.fainted && m->effect.type == EffectType::Buff && !o.hasBuff(m->effect.stat)) need = true;
                if (need) { a.kind = Action::UseMove; a.move = m; a.target = &u; return a; }
                continue;
            }
            if (m->target == Target::Ally) {
                Unit* best = nullptr;
                const int reach = reachOf(*m, *u.sp, spotOf(u));
                for (Unit& o : units_) {
                    if (o.side != u.side || o.fainted || distance(u, o) > reach) continue;
                    bool need = m->effect.type == EffectType::Heal ? o.hp * 100 < o.maxHp * 60
                                                                   : (o.shield == 0 && o.hp * 100 < o.maxHp * 70);
                    if (need && (!best || o.hpPermille() < best->hpPermille())) best = &o;
                }
                if (best) { a.kind = Action::UseMove; a.move = m; a.target = best; return a; }
                continue;
            }
            std::vector<Unit*> cands = foeTargets(u, *m);
            if (!m->dealsDamage()) {
                // Status-only moves skip foes that already have that status.
                std::vector<Unit*> fresh;
                for (Unit* c : cands) if (!statusOf(*c, m->effect.type).active()) fresh.push_back(c);
                cands = fresh;
            }
            if (!cands.empty()) { a.kind = Action::UseMove; a.move = m; a.target = pickFoe(u, cands); return a; }
        }
        // Nothing usable: step toward the enemy if possible, otherwise rest.
        if (!u.snare.active()) {
            int bestCol = -1, bestRow = -1, bestDist = nearestFoeDistance(u, u.col, u.row);
            for (int c = 0; c < 2; ++c)
                for (int r = 0; r < 3; ++r) {
                    if (std::abs(c - u.col) + std::abs(r - u.row) != 1) continue;
                    if (occupied(u.side, c, r) || !canStandOn(*u.sp, spots_[u.side][c][r])) continue;
                    int d = nearestFoeDistance(u, c, r);
                    if (d < bestDist) { bestDist = d; bestCol = c; bestRow = r; }
                }
            if (bestCol >= 0) { a.kind = Action::Reposition; a.toCol = bestCol; a.toRow = bestRow; return a; }
        }
        a.kind = Action::Rest;
        return a;
    }

    bool occupied(int side, int col, int row) const {
        for (const Unit& o : units_) if (o.side == side && !o.fainted && o.col == col && o.row == row) return true;
        return false;
    }

    int nearestFoeDistance(const Unit& u, int col, int row) const {
        int best = 99;
        for (const Unit& o : units_) {
            if (o.side == u.side || o.fainted) continue;
            int d = std::abs(xOf(u.side, col) - xOf(o.side, o.col)) + std::abs(row - o.row);
            best = std::min(best, d);
        }
        return best;
    }

    Status& statusOf(Unit& u, EffectType t) {
        switch (t) {
            case EffectType::Burn: return u.burn;
            case EffectType::Poison: return u.poison;
            case EffectType::Snare: return u.snare;
            case EffectType::Slow: return u.slow;
            case EffectType::Blind: return u.blind;
            default: return dummy_;
        }
    }

    bool stillValid(Unit& u, const Action& a) {
        if (a.kind != Action::UseMove) return true;
        const Move& m = *a.move;
        if (u.cooldown[m.id] > 0 || u.stamina < m.staminaCost) return false;
        if (m.target == Target::Foe) return a.target && canHit(u, m, *a.target);
        if (m.target == Target::Ally) return a.target && !a.target->fainted;
        return true;
    }

    // ---- a round ----
    void playRound() {
        struct Turn { Unit* unit; Action action; int priority; int speed; uint64_t tiebreak; };
        std::vector<Turn> turns;
        for (Unit& u : units_) {
            if (u.fainted) continue;
            Turn t{&u, choose(u), 0, stat(u, Stat::Speed), rng_.next()};
            if (t.action.kind == Action::UseMove) {
                t.priority = t.action.move->priority;
                if (t.action.move->hasFlag("priorityFromPerch") && spotOf(u) == SpotType::Perch) t.priority += 1;
            }
            turns.push_back(t);
        }
        std::stable_sort(turns.begin(), turns.end(), [](const Turn& a, const Turn& b) {
            if (a.priority != b.priority) return a.priority > b.priority;
            if (a.speed != b.speed) return a.speed > b.speed;
            return a.tiebreak < b.tiebreak;
        });
        for (Turn& t : turns) {
            Unit& u = *t.unit;
            if (u.fainted) continue;
            if (knockoutWinner() != -1) return;
            if (u.ind.attitude == Attitude::Wild && rng_.chancePermille(100)) {
                emit(event("distracted").set("actor", u.uid));
                continue;
            }
            Action a = t.action;
            if (!stillValid(u, a)) a = choose(u);
            perform(u, a);
        }
    }

    void perform(Unit& u, const Action& a) {
        if (a.kind == Action::Rest) {
            const int before = u.stamina;
            u.stamina = std::min(u.maxStamina, u.stamina + 15);
            emit(event("rest").set("actor", u.uid).set("stamina", u.stamina).set("gained", u.stamina - before));
            return;
        }
        if (a.kind == Action::Reposition) {
            Json from = spotJson(u.side, u.col, u.row);
            u.col = a.toCol;
            u.row = a.toRow;
            emit(event("reposition").set("actor", u.uid).set("from", from).set("to", spotJson(u.side, u.col, u.row)));
            return;
        }
        useMove(u, *a.move, a.target);
    }

    void useMove(Unit& u, const Move& m, Unit* primary) {
        u.stamina -= m.staminaCost;
        u.cooldown[m.id] = m.cooldown + 1;  // counts down at end of round; usable again at 0

        Json ev = event("move");
        ev.set("actor", u.uid).set("move", m.id).set("moveName", m.name).set("element", toString(m.element))
            .set("category", toString(m.category)).set("area", toString(m.area))
            .set("animation", m.animation).set("camera", m.camera).set("hype", m.hype)
            .set("staminaAfter", u.stamina);
        Json results = Json::array();

        if (m.target == Target::Self || m.target == Target::Ally || m.target == Target::Allies) {
            std::vector<Unit*> targets;
            if (m.target == Target::Allies) {
                for (Unit& o : units_) if (o.side == u.side && !o.fainted) targets.push_back(&o);
            } else {
                targets.push_back(primary);
            }
            for (Unit* t : targets) results.push(applySupport(*t, m));
            ev.set("targets", results);
            emit(ev);
            return;
        }

        std::vector<Unit*> targets = areaTargets(u, m, primary);
        std::vector<std::pair<int, int>> hitSpots;
        for (Unit* t : targets) {
            Json r = Json::object();
            r.set("target", t->uid);
            int acc = m.accuracy * 10;
            if (u.blind.active()) acc = acc * (1000 - u.blind.value * 10) / 1000;
            int ev2 = evasion(*t);
            if (m.area != Area::Single && t->sp->size == Size::Small) ev2 += 200;
            const int chance = acc * (1000 - std::min(ev2, 900)) / 1000;
            if (!rng_.chancePermille(chance)) {
                r.set("hit", false);
                results.push(r);
                continue;
            }
            r.set("hit", true);
            hitSpots.push_back({t->col, t->row});
            if (m.dealsDamage()) {
                int typeMod = 0;
                bool crit = false, surge = false;
                const int dmg = damage(u, *t, m, typeMod, crit, surge);
                const int absorbed = std::min(t->shield, dmg);
                t->shield -= absorbed;
                t->hp = std::max(0, t->hp - (dmg - absorbed));
                r.set("damage", dmg).set("typeModPermille", typeMod).set("crit", crit);
                if (surge) r.set("wildSurge", true);
                if (absorbed) r.set("shieldAbsorbed", absorbed);
            }
            if (t->hp > 0) maybeApplyStatus(*t, m, r);
            r.set("hpAfter", t->hp);
            results.push(r);
        }
        ev.set("targets", results);
        emit(ev);

        if (m.terrain != Terrain::None) changeTerrain(1 - u.side, m.terrain, hitSpots);
        for (Unit* t : targets) checkFaint(*t);
    }

    std::vector<Unit*> areaTargets(const Unit& u, const Move& m, Unit* primary) {
        std::vector<Unit*> out;
        if (m.area == Area::Field) return foeTargets(u, m);
        if (!primary) return out;
        out.push_back(primary);
        const int px = xOf(primary->side, primary->col);
        const int ux = xOf(u.side, u.col);
        for (Unit& t : units_) {
            if (&t == primary || t.fainted || t.side == u.side || !canBeHitBy(m, *t.sp, spotOf(t))) continue;
            const int tx = xOf(t.side, t.col);
            bool in = false;
            switch (m.area) {
                case Area::Line: in = t.row == primary->row && std::abs(tx - ux) > std::abs(px - ux); break;
                case Area::Cone: in = tx == px && std::abs(t.row - primary->row) == 1; break;
                case Area::Burst: in = distance(t, *primary) == 1; break;
                default: break;
            }
            if (in) out.push_back(&t);
        }
        return out;
    }

    int damage(const Unit& u, const Unit& t, const Move& m, int& typeMod, bool& crit, bool& surge) {
        const bool strike = m.category == Category::Strike;
        const int64_t atk = stat(u, strike ? Stat::Attack : Stat::Focus);
        const int64_t def = std::max(1, stat(t, strike ? Stat::Defense : Stat::Focus));
        // v holds damage x 1000 so every multiplier stays in integer permille math.
        int64_t v = static_cast<int64_t>(m.power) * atk * 350 / def;
        auto apply = [&](int64_t permille) { v = v * permille / 1000; };

        typeMod = cat_.types().vs(m.element, t.sp->elements);
        apply(typeMod);
        apply(cat_.types().weather(weather_, m.element));
        if (m.hasFlag("doubleInRain") && weather_ == Weather::Rain) apply(2000);
        if (t.sp->form == Form::Flier && (m.element == Element::Volt || m.element == Element::Gale)) apply(1250);
        if (m.contact && (u.sp->size == Size::Large || u.sp->size == Size::Huge)) apply(1150);
        if (spotOf(t) == SpotType::Cover && !m.contact && !m.hasFlag("ignoreCover")) apply(750);
        int critChance = u.ind.hidden.critPermille + (u.ind.attitude == Attitude::Fierce ? 100 : 0);
        crit = rng_.chancePermille(critChance);
        if (crit) apply(1500);
        surge = u.ind.attitude == Attitude::Wild && rng_.chancePermille(100);
        if (surge) apply(1250);
        apply(rng_.range(900, 1100));
        return static_cast<int>(std::max<int64_t>(1, (v + 500) / 1000));
    }

    void maybeApplyStatus(Unit& t, const Move& m, Json& r) {
        const EffectType et = m.effect.type;
        if (et != EffectType::Burn && et != EffectType::Poison && et != EffectType::Snare &&
            et != EffectType::Slow && et != EffectType::Blind)
            return;
        if (!rng_.chancePermille(m.effect.chancePct * 10)) return;
        Status& s = statusOf(t, et);
        s.rounds = std::max(s.rounds, m.effect.durationRounds);
        s.value = m.effect.value;
        r.set("status", toString(et)).set("statusRounds", s.rounds);
    }

    Json applySupport(Unit& t, const Move& m) {
        Json r = Json::object();
        r.set("target", t.uid);
        const Effect& e = m.effect;
        switch (e.type) {
            case EffectType::Heal: {
                const int before = t.hp;
                t.hp = std::min(t.maxHp, t.hp + t.maxHp * e.value / 100);
                r.set("healed", t.hp - before).set("hpAfter", t.hp);
                break;
            }
            case EffectType::Shield:
                t.shield = t.maxHp * e.value / 100;
                t.shieldRounds = e.durationRounds;
                r.set("shield", t.shield).set("shieldRounds", t.shieldRounds);
                break;
            case EffectType::Buff: {
                t.buffs.erase(std::remove_if(t.buffs.begin(), t.buffs.end(), [&](const Buff& b) { return b.stat == e.stat; }),
                              t.buffs.end());
                t.buffs.push_back({e.stat, e.value, e.durationRounds});
                r.set("buff", toString(e.stat)).set("pct", e.value).set("rounds", e.durationRounds);
                break;
            }
            case EffectType::Weather:
                weather_ = e.weather;
                r.set("weather", toString(weather_));
                break;
            default: break;
        }
        return r;
    }

    void changeTerrain(int side, Terrain terrain, const std::vector<std::pair<int, int>>& hitSpots) {
        for (const auto& cr : hitSpots) {
            SpotType& s = spots_[side][cr.first][cr.second];
            SpotType before = s;
            if (terrain == Terrain::Scorch && (s == SpotType::TallGrass || s == SpotType::OpenField)) s = SpotType::Scorched;
            if (terrain == Terrain::Freeze && s == SpotType::Shallows) s = SpotType::OpenField;
            if (s != before) {
                emit(event("terrain_change").set("spot", spotJson(side, cr.first, cr.second))
                         .set("from", toString(before)).set("to", toString(s)));
            }
        }
    }

    void checkFaint(Unit& u) {
        if (!u.fainted && u.hp <= 0) {
            u.fainted = true;
            u.hp = 0;
            emit(event("faint").set("actor", u.uid));
        }
    }

    void endOfRound() {
        for (Unit& u : units_) {
            if (u.fainted) continue;
            auto tick = [&](const char* cause, int pct) {
                const int dmg = std::max(1, u.maxHp * pct / 100);
                u.hp = std::max(0, u.hp - dmg);
                emit(event("tick").set("actor", u.uid).set("cause", cause).set("damage", dmg).set("hpAfter", u.hp));
            };
            if (u.burn.active()) tick("burn", u.burn.value);
            if (u.poison.active()) tick("poison", u.poison.value);
            const bool emberType = std::find(u.sp->elements.begin(), u.sp->elements.end(), Element::Ember) != u.sp->elements.end();
            if (spotOf(u) == SpotType::Scorched && !emberType && u.sp->form != Form::Flier) tick("scorched_ground", 5);
            checkFaint(u);
        }
        for (Unit& u : units_) {
            if (u.fainted) continue;
            for (Status* s : {&u.burn, &u.poison, &u.snare, &u.slow, &u.blind}) if (s->rounds > 0) --s->rounds;
            for (Buff& b : u.buffs) --b.rounds;
            u.buffs.erase(std::remove_if(u.buffs.begin(), u.buffs.end(), [](const Buff& b) { return b.rounds <= 0; }), u.buffs.end());
            if (u.shieldRounds > 0 && --u.shieldRounds == 0) u.shield = 0;
            for (auto& cd : u.cooldown) if (cd.second > 0) --cd.second;
            u.stamina = std::min(u.maxStamina, u.stamina + u.ind.hidden.staminaRegen);
        }
    }

    int knockoutWinner() const {
        bool alive[2] = {false, false};
        for (const Unit& u : units_) if (!u.fainted) alive[u.side] = true;
        if (alive[0] && !alive[1]) return 0;
        if (alive[1] && !alive[0]) return 1;
        if (!alive[0] && !alive[1]) return kDoubleKnockout;
        return -1;
    }

    // ---- replay ----
    Json event(const char* type) const {
        Json e = Json::object();
        e.set("round", round_).set("type", type);
        return e;
    }
    void emit(Json e) { events_->push(std::move(e)); }

    Json spotJson(int side, int col, int row) const {
        Json j = Json::object();
        j.set("side", side).set("col", col).set("row", row).set("type", toString(spots_[side][col][row]));
        return j;
    }

    Json header() const {
        Json h = Json::object();
        h.set("format", "creature-league-replay").set("version", 1).set("seed", setup_.seed);
        Json st = Json::object();
        Json spots = Json::array();
        for (int c = 0; c < 2; ++c)
            for (int r = 0; r < 3; ++r) {
                Json s = Json::object();
                s.set("col", c).set("row", r).set("type", toString(stadium_.spots[c][r]));
                spots.push(s);
            }
        st.set("id", stadium_.id).set("name", stadium_.name).set("spots", spots);
        h.set("stadium", st);
        h.set("weather", toString(setup_.weather ? *setup_.weather : stadium_.defaultWeather));
        h.set("maxRounds", setup_.maxRounds);
        Json teams = Json::array();
        for (int s = 0; s < 2; ++s) {
            Json team = Json::object();
            team.set("name", setup_.teams[s].name);
            Json members = Json::array();
            for (int i = 0; i < kTeamSize; ++i) {
                const Placement& p = setup_.teams[s].members[i];
                const Species& sp = cat_.species(p.creature.speciesId);
                Json m = Json::object();
                m.set("uid", std::string(1, static_cast<char>('A' + s)) + std::to_string(i + 1))
                    .set("name", sp.name).set("individual", p.creature.toJson())
                    .set("spot", Json::object().set("col", p.col).set("row", p.row).set("type", toString(stadium_.spots[p.col][p.row])))
                    .set("tactic", toString(p.tactic));
                Json plan = Json::array();
                for (const Move* mv : units_[s * kTeamSize + i].plan) plan.push(mv->id);
                m.set("movePlan", plan);
                members.push(m);
            }
            team.set("members", members);
            teams.push(team);
        }
        h.set("teams", teams);
        return h;
    }

    const Catalog& cat_;
    const BattleSetup& setup_;
    const Stadium& stadium_;
    Rng rng_;
    Weather weather_ = Weather::Clear;
    std::array<std::array<std::array<SpotType, 3>, 2>, 2> spots_{};
    std::vector<Unit> units_;
    Json* events_ = nullptr;
    int round_ = 0;
    Status dummy_;
};

}  // namespace

BattleResult runBattle(const Catalog& catalog, const BattleSetup& setup) {
    validateSetup(catalog, setup);
    Battle b(catalog, setup);
    return b.run();
}

}  // namespace cl
