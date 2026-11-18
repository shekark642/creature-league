// Deterministic random numbers (xoshiro256**, seeded with splitmix64).
// Only integer math, so the same seed gives the same sequence on every
// platform and compiler: the league server and Unreal must agree exactly.
#pragma once

#include <cstdint>

namespace cl {

class Rng {
public:
    explicit Rng(uint64_t seed) {
        uint64_t x = seed;
        for (auto& s : s_) s = splitmix(x);
    }

    uint64_t next() {
        const uint64_t result = rotl(s_[1] * 5, 7) * 9;
        const uint64_t t = s_[1] << 17;
        s_[2] ^= s_[0];
        s_[3] ^= s_[1];
        s_[1] ^= s_[2];
        s_[0] ^= s_[3];
        s_[2] ^= t;
        s_[3] = rotl(s_[3], 45);
        return result;
    }

    // Uniform integer in [0, n). Rejection sampling keeps it unbiased.
    uint64_t below(uint64_t n) {
        if (n <= 1) return 0;
        const uint64_t limit = UINT64_MAX - (UINT64_MAX % n);
        uint64_t v;
        do { v = next(); } while (v >= limit);
        return v % n;
    }

    // Uniform integer in [lo, hi].
    int64_t range(int64_t lo, int64_t hi) {
        return lo + static_cast<int64_t>(below(static_cast<uint64_t>(hi - lo + 1)));
    }

    // True with probability permille / 1000.
    bool chancePermille(int64_t permille) {
        if (permille <= 0) return false;
        if (permille >= 1000) return true;
        return static_cast<int64_t>(below(1000)) < permille;
    }

    // Derive an independent seed, e.g. one per individual creature.
    static uint64_t mix(uint64_t a, uint64_t b) {
        uint64_t x = a ^ (b + 0x9E3779B97F4A7C15ULL + (a << 6) + (a >> 2));
        return splitmix(x);
    }

private:
    static uint64_t rotl(uint64_t x, int k) { return (x << k) | (x >> (64 - k)); }
    static uint64_t splitmix(uint64_t& x) {
        uint64_t z = (x += 0x9E3779B97F4A7C15ULL);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
    uint64_t s_[4];
};

}  // namespace cl
