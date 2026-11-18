#include "cl/catalog.hpp"

#include <algorithm>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <utility>

#include "cl/rng.hpp"

namespace cl {

namespace {

template <typename E>
struct Names;

#define CL_NAMES(E, ...)                                                    \
    template <>                                                             \
    struct Names<E> {                                                       \
        static const std::vector<std::pair<E, const char*>>& list() {       \
            static const std::vector<std::pair<E, const char*>> l = {__VA_ARGS__}; \
            return l;                                                       \
        }                                                                   \
        static const char* kind() { return #E; }                            \
    };

CL_NAMES(Element, {Element::Ember, "ember"}, {Element::Tide, "tide"}, {Element::Grove, "grove"},
         {Element::Stone, "stone"}, {Element::Gale, "gale"}, {Element::Volt, "volt"},
         {Element::Frost, "frost"}, {Element::Venom, "venom"})
CL_NAMES(Form, {Form::Walker, "walker"}, {Form::Flier, "flier"}, {Form::Swimmer, "swimmer"},
         {Form::Burrower, "burrower"})
CL_NAMES(Size, {Size::Small, "small"}, {Size::Medium, "medium"}, {Size::Large, "large"}, {Size::Huge, "huge"})
CL_NAMES(Habitat, {Habitat::Forest, "forest"}, {Habitat::River, "river"}, {Habitat::Volcanic, "volcanic"},
         {Habitat::Coast, "coast"}, {Habitat::Alpine, "alpine"}, {Habitat::Wetland, "wetland"})
CL_NAMES(Attitude, {Attitude::Bold, "bold"}, {Attitude::Calm, "calm"}, {Attitude::Fierce, "fierce"},
         {Attitude::Timid, "timid"}, {Attitude::Loyal, "loyal"}, {Attitude::Wild, "wild"})
CL_NAMES(Category, {Category::Strike, "strike"}, {Category::Elemental, "elemental"},
         {Category::Support, "support"})
CL_NAMES(Range, {Range::Self, "self"}, {Range::Melee, "melee"}, {Range::Mid, "mid"}, {Range::Long, "long"})
CL_NAMES(Area, {Area::Self, "self"}, {Area::Single, "single"}, {Area::Line, "line"}, {Area::Cone, "cone"},
         {Area::Burst, "burst"}, {Area::Field, "field"})
CL_NAMES(Target, {Target::Foe, "foe"}, {Target::Self, "self"}, {Target::Ally, "ally"}, {Target::Allies, "allies"})
CL_NAMES(EffectType, {EffectType::None, "none"}, {EffectType::Burn, "burn"}, {EffectType::Poison, "poison"},
         {EffectType::Snare, "snare"}, {EffectType::Slow, "slow"}, {EffectType::Blind, "blind"},
         {EffectType::Buff, "buff"}, {EffectType::Shield, "shield"}, {EffectType::Heal, "heal"},
         {EffectType::Weather, "weather"})
CL_NAMES(Stat, {Stat::None, "none"}, {Stat::Attack, "attack"}, {Stat::Defense, "defense"},
         {Stat::Focus, "focus"}, {Stat::Speed, "speed"}, {Stat::Evasion, "evasion"})
CL_NAMES(SpotType, {SpotType::Perch, "perch"}, {SpotType::Cover, "cover"}, {SpotType::SoftGround, "soft_ground"},
         {SpotType::Shallows, "shallows"}, {SpotType::OpenField, "open_field"},
         {SpotType::TallGrass, "tall_grass"}, {SpotType::Scorched, "scorched"})
CL_NAMES(Weather, {Weather::Clear, "clear"}, {Weather::Rain, "rain"}, {Weather::Sun, "sun"},
         {Weather::Snow, "snow"}, {Weather::Storm, "storm"})
CL_NAMES(Terrain, {Terrain::None, "none"}, {Terrain::Scorch, "scorch"}, {Terrain::Freeze, "freeze"})
CL_NAMES(Tactic, {Tactic::Aggressive, "aggressive"}, {Tactic::Guardian, "guardian"},
         {Tactic::Disruptor, "disruptor"}, {Tactic::Skirmisher, "skirmisher"})

#undef CL_NAMES

Stats parseStats(const Json& j) {
    Stats s;
    s.hp = static_cast<int>(j.at("hp").asInt());
    s.attack = static_cast<int>(j.at("attack").asInt());
    s.defense = static_cast<int>(j.at("defense").asInt());
    s.focus = static_cast<int>(j.at("focus").asInt());
    s.speed = static_cast<int>(j.at("speed").asInt());
    s.stamina = static_cast<int>(j.at("stamina").asInt());
    return s;
}

HiddenStats parseHidden(const Json& j) {
    HiddenStats h;
    auto num = [&](const char* k, int def) { return j.has(k) ? static_cast<int>(j.at(k).asInt()) : def; };
    h.evasionPermille = num("evasionPermille", h.evasionPermille);
    h.critPermille = num("critPermille", h.critPermille);
    h.staminaRegen = num("staminaRegen", h.staminaRegen);
    h.weightKg = num("weightKg", h.weightKg);
    h.morale = num("morale", h.morale);
    h.composure = num("composure", h.composure);
    h.aggression = num("aggression", h.aggression);
    h.catchDifficulty = num("catchDifficulty", h.catchDifficulty);
    h.broadcastFlair = num("broadcastFlair", h.broadcastFlair);
    return h;
}

}  // namespace

template <typename E>
E parseEnum(const std::string& s) {
    for (const auto& p : Names<E>::list()) if (s == p.second) return p.first;
    throw std::runtime_error(std::string("unknown ") + Names<E>::kind() + " '" + s + "'");
}

template <typename E>
const char* toString(E e) {
    for (const auto& p : Names<E>::list()) if (e == p.first) return p.second;
    return "?";
}

#define CL_INSTANTIATE(E) \
    template E parseEnum<E>(const std::string&); \
    template const char* toString<E>(E);
CL_INSTANTIATE(Element)
CL_INSTANTIATE(Form)
CL_INSTANTIATE(Size)
CL_INSTANTIATE(Habitat)
CL_INSTANTIATE(Attitude)
CL_INSTANTIATE(Category)
CL_INSTANTIATE(Range)
CL_INSTANTIATE(Area)
CL_INSTANTIATE(Target)
CL_INSTANTIATE(EffectType)
CL_INSTANTIATE(Stat)
CL_INSTANTIATE(SpotType)
CL_INSTANTIATE(Weather)
CL_INSTANTIATE(Terrain)
CL_INSTANTIATE(Tactic)
#undef CL_INSTANTIATE

bool Move::hasFlag(const std::string& f) const {
    return std::find(flags.begin(), flags.end(), f) != flags.end();
}

int TypeChart::vs(Element attack, Element defend) const {
    return table[static_cast<int>(attack)][static_cast<int>(defend)];
}

int TypeChart::vs(Element attack, const std::vector<Element>& defend) const {
    int64_t m = 1000;
    for (Element d : defend) m = m * vs(attack, d) / 1000;
    return static_cast<int>(m);
}

int TypeChart::weather(Weather w, Element e) const {
    auto wi = weatherPermille.find(w);
    if (wi == weatherPermille.end()) return 1000;
    auto ei = wi->second.find(e);
    return ei == wi->second.end() ? 1000 : ei->second;
}

std::string readFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("cannot open " + path);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

Catalog Catalog::load(const std::string& dataDir) {
    Catalog c;

    // Elements and the type chart.
    const Json el = Json::parse(readFile(dataDir + "/elements.json"));
    c.types_.strongPermille = static_cast<int>(el.at("strongMultiplierPermille").asInt());
    c.types_.weakPermille = static_cast<int>(el.at("weakMultiplierPermille").asInt());
    for (auto& row : c.types_.table) row.fill(1000);
    for (const auto& kv : el.at("strongAgainst").asObject()) {
        Element atk = parseEnum<Element>(kv.first);
        for (const Json& d : kv.second.asArray()) {
            Element def = parseEnum<Element>(d.asString());
            c.types_.table[static_cast<int>(atk)][static_cast<int>(def)] = c.types_.strongPermille;
            c.types_.table[static_cast<int>(def)][static_cast<int>(atk)] = c.types_.weakPermille;
        }
    }
    for (const auto& kv : el.at("weather").asObject()) {
        Weather w = parseEnum<Weather>(kv.first);
        auto& m = c.types_.weatherPermille[w];
        for (const auto& e : kv.second.asObject()) m[parseEnum<Element>(e.first)] = static_cast<int>(e.second.asInt());
    }

    // Moves.
    const Json mv = Json::parse(readFile(dataDir + "/moves.json"));
    for (const Json& j : mv.at("moves").asArray()) {
        Move m;
        m.id = j.at("id").asString();
        m.name = j.at("name").asString();
        m.element = parseEnum<Element>(j.at("element").asString());
        m.category = parseEnum<Category>(j.at("category").asString());
        m.power = static_cast<int>(j.at("power").asInt());
        m.accuracy = static_cast<int>(j.at("accuracy").asInt());
        m.staminaCost = static_cast<int>(j.at("staminaCost").asInt());
        m.range = parseEnum<Range>(j.at("range").asString());
        m.area = parseEnum<Area>(j.at("area").asString());
        m.cooldown = static_cast<int>(j.at("cooldown").asInt());
        m.priority = static_cast<int>(j.at("priority").asInt());
        m.contact = j.at("contact").asBool();
        m.target = parseEnum<Target>(j.at("target").asString());
        m.groundWave = j.get("groundWave").isNull() ? false : j.at("groundWave").asBool();
        if (j.has("effect")) {
            const Json& e = j.at("effect");
            m.effect.type = parseEnum<EffectType>(e.at("type").asString());
            m.effect.chancePct = static_cast<int>(e.at("chancePct").asInt());
            m.effect.value = static_cast<int>(e.at("value").asInt());
            m.effect.durationRounds = static_cast<int>(e.at("durationRounds").asInt());
            if (e.has("stat")) {
                if (m.effect.type == EffectType::Weather) m.effect.weather = parseEnum<Weather>(e.at("stat").asString());
                else m.effect.stat = parseEnum<Stat>(e.at("stat").asString());
            }
        }
        m.terrain = parseEnum<Terrain>(j.at("terrain").asString());
        for (const Json& f : j.at("flags").asArray()) m.flags.push_back(f.asString());
        const Json& p = j.at("presentation");
        m.animation = p.at("animation").asString();
        m.camera = p.at("camera").asString();
        m.hype = static_cast<int>(p.at("hype").asInt());
        if (c.moves_.count(m.id)) throw std::runtime_error("duplicate move id " + m.id);
        c.moves_.emplace(m.id, m);
    }

    // Species.
    const Json sp = Json::parse(readFile(dataDir + "/species.json"));
    for (const Json& j : sp.at("species").asArray()) {
        Species s;
        s.id = j.at("id").asString();
        s.name = j.at("name").asString();
        s.basedOn = j.at("basedOn").asString();
        s.rarity = j.at("rarity").asString();
        for (const Json& e : j.at("elements").asArray()) s.elements.push_back(parseEnum<Element>(e.asString()));
        s.form = parseEnum<Form>(j.at("form").asString());
        s.size = parseEnum<Size>(j.at("size").asString());
        s.habitat = parseEnum<Habitat>(j.at("habitat").asString());
        s.base = parseStats(j.at("base"));
        s.usualAttitude = parseEnum<Attitude>(j.at("usualAttitude").asString());
        s.hidden = parseHidden(j.at("hidden"));
        for (const Json& m : j.at("moves").asArray()) {
            const std::string& id = m.asString();
            if (!c.moves_.count(id)) throw std::runtime_error("species " + s.id + " uses unknown move " + id);
            s.moves.push_back(id);
        }
        if (s.elements.empty() || s.elements.size() > 2)
            throw std::runtime_error("species " + s.id + " must have 1 or 2 elements");
        if (s.moves.size() < 2 || s.moves.size() > 5)
            throw std::runtime_error("species " + s.id + " must have 2 to 5 moves");
        if (c.species_.count(s.id)) throw std::runtime_error("duplicate species id " + s.id);
        c.species_.emplace(s.id, s);
    }

    // Stadiums.
    const Json st = Json::parse(readFile(dataDir + "/stadiums.json"));
    for (const Json& j : st.at("stadiums").asArray()) {
        Stadium s;
        s.id = j.at("id").asString();
        s.name = j.at("name").asString();
        s.defaultWeather = parseEnum<Weather>(j.at("defaultWeather").asString());
        std::array<std::array<bool, 3>, 2> seen{};
        for (const Json& spot : j.at("spots").asArray()) {
            int col = static_cast<int>(spot.at("col").asInt());
            int row = static_cast<int>(spot.at("row").asInt());
            if (col < 0 || col > 1 || row < 0 || row > 2)
                throw std::runtime_error("stadium " + s.id + " has a spot outside the 2x3 grid");
            s.spots[col][row] = parseEnum<SpotType>(spot.at("type").asString());
            seen[col][row] = true;
        }
        for (auto& col : seen)
            for (bool b : col)
                if (!b) throw std::runtime_error("stadium " + s.id + " must define all 6 spots");
        c.stadiums_.emplace(s.id, s);
    }
    return c;
}

const Species& Catalog::species(const std::string& id) const {
    auto it = species_.find(id);
    if (it == species_.end()) throw std::runtime_error("unknown species '" + id + "'");
    return it->second;
}
const Move& Catalog::move(const std::string& id) const {
    auto it = moves_.find(id);
    if (it == moves_.end()) throw std::runtime_error("unknown move '" + id + "'");
    return it->second;
}
const Stadium& Catalog::stadium(const std::string& id) const {
    auto it = stadiums_.find(id);
    if (it == stadiums_.end()) throw std::runtime_error("unknown stadium '" + id + "'");
    return it->second;
}

Individual rollIndividual(const Catalog& catalog, const std::string& speciesId, uint64_t seed,
                          const std::string& individualId) {
    const Species& sp = catalog.species(speciesId);
    Rng rng(Rng::mix(seed, 0xC0FFEE));
    Individual ind;
    ind.id = individualId.empty() ? speciesId + "#" + std::to_string(seed) : individualId;
    ind.speciesId = speciesId;
    ind.seed = seed;
    auto roll = [&](int base) {
        int64_t delta = rng.range(-kRollPermille, kRollPermille);
        return std::max(1, static_cast<int>((static_cast<int64_t>(base) * (1000 + delta) + 500) / 1000));
    };
    ind.stats.hp = roll(sp.base.hp);
    ind.stats.attack = roll(sp.base.attack);
    ind.stats.defense = roll(sp.base.defense);
    ind.stats.focus = roll(sp.base.focus);
    ind.stats.speed = roll(sp.base.speed);
    ind.stats.stamina = roll(sp.base.stamina);
    // 60% of individuals share the species' usual attitude; the rest are random.
    if (rng.chancePermille(600)) ind.attitude = sp.usualAttitude;
    else ind.attitude = static_cast<Attitude>(rng.below(6));
    ind.hidden = sp.hidden;
    ind.hidden.evasionPermille += static_cast<int>(rng.range(-10, 10));
    ind.hidden.critPermille += static_cast<int>(rng.range(-10, 10));
    return ind;
}

Json Individual::toJson() const {
    Json j = Json::object();
    j.set("id", id).set("species", speciesId).set("seed", seed).set("attitude", toString(attitude));
    Json s = Json::object();
    s.set("hp", stats.hp).set("attack", stats.attack).set("defense", stats.defense)
        .set("focus", stats.focus).set("speed", stats.speed).set("stamina", stats.stamina);
    j.set("stats", s);
    return j;
}

}  // namespace cl
