// Game data: elements, species, moves and stadiums, loaded from the JSON files in data/.
#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "cl/json.hpp"

namespace cl {

enum class Element { Ember, Tide, Grove, Stone, Gale, Volt, Frost, Venom, Count };
enum class Form { Walker, Flier, Swimmer, Burrower };
enum class Size { Small, Medium, Large, Huge };
enum class Habitat { Forest, River, Volcanic, Coast, Alpine, Wetland };
enum class Attitude { Bold, Calm, Fierce, Timid, Loyal, Wild };
enum class Category { Strike, Elemental, Support };
enum class Range { Self, Melee, Mid, Long };
enum class Area { Self, Single, Line, Cone, Burst, Field };
enum class Target { Foe, Self, Ally, Allies };
enum class EffectType { None, Burn, Poison, Snare, Slow, Blind, Buff, Shield, Heal, Weather };
enum class Stat { None, Attack, Defense, Focus, Speed, Evasion };
enum class SpotType { Perch, Cover, SoftGround, Shallows, OpenField, TallGrass, Scorched };
enum class Weather { Clear, Rain, Sun, Snow, Storm };
enum class Terrain { None, Scorch, Freeze };
enum class Tactic { Aggressive, Guardian, Disruptor, Skirmisher };

// String conversions used by the data files and the replay log.
template <typename E> E parseEnum(const std::string& s);
template <typename E> const char* toString(E e);

struct Stats {
    int hp = 0, attack = 0, defense = 0, focus = 0, speed = 0, stamina = 0;
};

// Stats the game uses but players never see on the creature card.
struct HiddenStats {
    int evasionPermille = 50;
    int critPermille = 50;
    int staminaRegen = 5;
    int weightKg = 0;
    int morale = 70;
    int composure = 50;
    int aggression = 50;
    int catchDifficulty = 50;
    int broadcastFlair = 3;
};

struct Species {
    std::string id, name, basedOn, rarity;
    std::vector<Element> elements;  // 1 or 2
    Form form = Form::Walker;
    Size size = Size::Medium;
    Habitat habitat = Habitat::Forest;
    Stats base;
    Attitude usualAttitude = Attitude::Calm;
    HiddenStats hidden;
    std::vector<std::string> moves;  // 2 to 5 move ids
};

struct Effect {
    EffectType type = EffectType::None;
    int chancePct = 0;
    int value = 0;           // percent: damage per round, heal, shield or buff size
    int durationRounds = 0;
    Stat stat = Stat::None;  // for buffs
    Weather weather = Weather::Clear;  // for weather moves
};

struct Move {
    std::string id, name;
    Element element = Element::Ember;
    Category category = Category::Strike;
    int power = 0, accuracy = 100, staminaCost = 0, cooldown = 0, priority = 0;
    Range range = Range::Melee;
    Area area = Area::Single;
    Target target = Target::Foe;
    bool contact = false;
    bool groundWave = false;
    Effect effect;
    Terrain terrain = Terrain::None;
    std::vector<std::string> flags;
    // Presentation fields for the stadium broadcast; the simulator only passes them through.
    std::string animation, camera;
    int hype = 0;

    bool hasFlag(const std::string& f) const;
    bool dealsDamage() const { return power > 0; }
};

struct TypeChart {
    int strongPermille = 1500;
    int weakPermille = 667;
    std::array<std::array<int, static_cast<int>(Element::Count)>, static_cast<int>(Element::Count)> table{};
    std::map<Weather, std::map<Element, int>> weatherPermille;

    // Multiplier for one attacking element against one defending element, in permille.
    int vs(Element attack, Element defend) const;
    // Multiplier against a creature with one or two elements (both apply).
    int vs(Element attack, const std::vector<Element>& defend) const;
    int weather(Weather w, Element e) const;
};

struct Stadium {
    std::string id, name;
    Weather defaultWeather = Weather::Clear;
    // spots[col][row]; each side mirrors this layout. Column 0 is the back row.
    std::array<std::array<SpotType, 3>, 2> spots{};
};

class Catalog {
public:
    static Catalog load(const std::string& dataDir);

    const TypeChart& types() const { return types_; }
    const Species& species(const std::string& id) const;
    const Move& move(const std::string& id) const;
    const Stadium& stadium(const std::string& id) const;
    const std::map<std::string, Species>& allSpecies() const { return species_; }
    const std::map<std::string, Move>& allMoves() const { return moves_; }
    const std::map<std::string, Stadium>& allStadiums() const { return stadiums_; }

private:
    TypeChart types_;
    std::map<std::string, Species> species_;
    std::map<std::string, Move> moves_;
    std::map<std::string, Stadium> stadiums_;
};

// One concrete creature: a species plus its own stat rolls and attitude.
// A league pool holds 3 individuals per species, each rolled from its own seed.
struct Individual {
    std::string id;
    std::string speciesId;
    Stats stats;
    Attitude attitude = Attitude::Calm;
    HiddenStats hidden;
    uint64_t seed = 0;

    Json toJson() const;
};

constexpr int kRollPermille = 80;  // visible stats vary by up to +/-8% from the species base

Individual rollIndividual(const Catalog& catalog, const std::string& speciesId, uint64_t seed,
                          const std::string& individualId = "");

std::string readFile(const std::string& path);

}  // namespace cl
