#include "cl/json.hpp"

#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace cl {

namespace {

class Parser {
public:
    explicit Parser(const std::string& t) : t_(t) {}

    Json parseDocument() {
        Json v = parseValue();
        skipWs();
        if (p_ != t_.size()) fail("trailing characters");
        return v;
    }

private:
    [[noreturn]] void fail(const std::string& what) const {
        throw std::runtime_error("JSON parse error at offset " + std::to_string(p_) + ": " + what);
    }
    void skipWs() {
        while (p_ < t_.size() && (t_[p_] == ' ' || t_[p_] == '\n' || t_[p_] == '\r' || t_[p_] == '\t')) ++p_;
    }
    char peek() {
        skipWs();
        if (p_ >= t_.size()) fail("unexpected end");
        return t_[p_];
    }
    void expect(char c) {
        if (peek() != c) fail(std::string("expected '") + c + "'");
        ++p_;
    }
    bool consumeWord(const char* w) {
        size_t n = std::char_traits<char>::length(w);
        if (t_.compare(p_, n, w) == 0) { p_ += n; return true; }
        return false;
    }

    Json parseValue() {
        char c = peek();
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '"') return Json(parseString());
        if (c == 't' && consumeWord("true")) return Json(true);
        if (c == 'f' && consumeWord("false")) return Json(false);
        if (c == 'n' && consumeWord("null")) return Json();
        if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
        fail("unexpected character");
    }

    Json parseObject() {
        expect('{');
        Json obj = Json::object();
        if (peek() == '}') { ++p_; return obj; }
        while (true) {
            if (peek() != '"') fail("expected key");
            std::string key = parseString();
            expect(':');
            obj.set(key, parseValue());
            char c = peek();
            ++p_;
            if (c == '}') return obj;
            if (c != ',') fail("expected ',' or '}'");
        }
    }

    Json parseArray() {
        expect('[');
        Json arr = Json::array();
        if (peek() == ']') { ++p_; return arr; }
        while (true) {
            arr.push(parseValue());
            char c = peek();
            ++p_;
            if (c == ']') return arr;
            if (c != ',') fail("expected ',' or ']'");
        }
    }

    std::string parseString() {
        expect('"');
        std::string out;
        while (true) {
            if (p_ >= t_.size()) fail("unterminated string");
            char c = t_[p_++];
            if (c == '"') return out;
            if (c != '\\') { out += c; continue; }
            if (p_ >= t_.size()) fail("bad escape");
            char e = t_[p_++];
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    if (p_ + 4 > t_.size()) fail("bad unicode escape");
                    unsigned cp = std::stoul(t_.substr(p_, 4), nullptr, 16);
                    p_ += 4;
                    // Encode the basic multilingual plane as UTF-8 (surrogate pairs not needed for our data).
                    if (cp < 0x80) out += static_cast<char>(cp);
                    else if (cp < 0x800) {
                        out += static_cast<char>(0xC0 | (cp >> 6));
                        out += static_cast<char>(0x80 | (cp & 0x3F));
                    } else {
                        out += static_cast<char>(0xE0 | (cp >> 12));
                        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                        out += static_cast<char>(0x80 | (cp & 0x3F));
                    }
                    break;
                }
                default: fail("bad escape");
            }
        }
    }

    Json parseNumber() {
        size_t start = p_;
        bool isDouble = false;
        if (t_[p_] == '-') ++p_;
        while (p_ < t_.size()) {
            char c = t_[p_];
            if (c >= '0' && c <= '9') { ++p_; continue; }
            if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { isDouble = true; ++p_; continue; }
            break;
        }
        std::string num = t_.substr(start, p_ - start);
        try {
            if (isDouble) return Json(std::stod(num));
            return Json(static_cast<int64_t>(std::stoll(num)));
        } catch (...) {
            fail("bad number '" + num + "'");
        }
    }

    const std::string& t_;
    size_t p_ = 0;
};

void escapeTo(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    out += '"';
}

const Json kNull;

}  // namespace

Json Json::parse(const std::string& text) { return Parser(text).parseDocument(); }

bool Json::asBool() const {
    if (type_ != Type::Bool) throw std::runtime_error("JSON value is not a bool");
    return b_;
}
int64_t Json::asInt() const {
    if (type_ == Type::Int) return i_;
    if (type_ == Type::Double) return static_cast<int64_t>(d_);
    throw std::runtime_error("JSON value is not a number");
}
double Json::asDouble() const {
    if (type_ == Type::Double) return d_;
    if (type_ == Type::Int) return static_cast<double>(i_);
    throw std::runtime_error("JSON value is not a number");
}
const std::string& Json::asString() const {
    if (type_ != Type::String) throw std::runtime_error("JSON value is not a string");
    return s_;
}
const Json::Array& Json::asArray() const {
    if (type_ != Type::Array) throw std::runtime_error("JSON value is not an array");
    return a_;
}
const Json::Object& Json::asObject() const {
    if (type_ != Type::Object) throw std::runtime_error("JSON value is not an object");
    return o_;
}

bool Json::has(const std::string& key) const {
    if (type_ != Type::Object) return false;
    for (const auto& kv : o_) if (kv.first == key) return true;
    return false;
}
const Json& Json::at(const std::string& key) const {
    for (const auto& kv : asObject()) if (kv.first == key) return kv.second;
    throw std::runtime_error("missing JSON key '" + key + "'");
}
const Json& Json::get(const std::string& key) const {
    if (type_ != Type::Object) return kNull;
    for (const auto& kv : o_) if (kv.first == key) return kv.second;
    return kNull;
}
Json& Json::set(const std::string& key, Json value) {
    if (type_ == Type::Null) type_ = Type::Object;
    if (type_ != Type::Object) throw std::runtime_error("JSON value is not an object");
    for (auto& kv : o_) {
        if (kv.first == key) { kv.second = std::move(value); return *this; }
    }
    o_.emplace_back(key, std::move(value));
    return *this;
}

size_t Json::size() const {
    if (type_ == Type::Array) return a_.size();
    if (type_ == Type::Object) return o_.size();
    return 0;
}
const Json& Json::operator[](size_t i) const { return asArray().at(i); }
Json& Json::push(Json value) {
    if (type_ == Type::Null) type_ = Type::Array;
    if (type_ != Type::Array) throw std::runtime_error("JSON value is not an array");
    a_.push_back(std::move(value));
    return *this;
}

std::string Json::dump(int indent) const {
    std::string out;
    dumpTo(out, indent, 0);
    return out;
}

void Json::dumpTo(std::string& out, int indent, int depth) const {
    auto newline = [&](int d) {
        if (indent < 0) return;
        out += '\n';
        out.append(static_cast<size_t>(indent * d), ' ');
    };
    switch (type_) {
        case Type::Null: out += "null"; break;
        case Type::Bool: out += b_ ? "true" : "false"; break;
        case Type::Int: out += std::to_string(i_); break;
        case Type::Double: {
            char buf[32];
            std::snprintf(buf, sizeof buf, "%.6g", d_);
            out += buf;
            break;
        }
        case Type::String: escapeTo(out, s_); break;
        case Type::Array:
            if (a_.empty()) { out += "[]"; break; }
            out += '[';
            for (size_t i = 0; i < a_.size(); ++i) {
                if (i) out += ',';
                newline(depth + 1);
                a_[i].dumpTo(out, indent, depth + 1);
            }
            newline(depth);
            out += ']';
            break;
        case Type::Object:
            if (o_.empty()) { out += "{}"; break; }
            out += '{';
            for (size_t i = 0; i < o_.size(); ++i) {
                if (i) out += ',';
                newline(depth + 1);
                escapeTo(out, o_[i].first);
                out += indent < 0 ? ":" : ": ";
                o_[i].second.dumpTo(out, indent, depth + 1);
            }
            newline(depth);
            out += '}';
            break;
    }
}

}  // namespace cl
