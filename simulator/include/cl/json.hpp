// Minimal JSON value with a parser and a stable serializer.
// Objects keep insertion order so replay files are byte-for-byte reproducible.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace cl {

class Json {
public:
    enum class Type { Null, Bool, Int, Double, String, Array, Object };
    using Array = std::vector<Json>;
    using Object = std::vector<std::pair<std::string, Json>>;

    Json() = default;
    Json(std::nullptr_t) {}
    Json(bool b) : type_(Type::Bool), b_(b) {}
    Json(int v) : type_(Type::Int), i_(v) {}
    Json(int64_t v) : type_(Type::Int), i_(v) {}
    Json(uint64_t v) : type_(Type::Int), i_(static_cast<int64_t>(v)) {}
    Json(double v) : type_(Type::Double), d_(v) {}
    Json(const char* s) : type_(Type::String), s_(s) {}
    Json(std::string s) : type_(Type::String), s_(std::move(s)) {}
    Json(Array a) : type_(Type::Array), a_(std::move(a)) {}

    static Json object() { Json j; j.type_ = Type::Object; return j; }
    static Json array() { Json j; j.type_ = Type::Array; return j; }
    static Json parse(const std::string& text);

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isObject() const { return type_ == Type::Object; }
    bool isArray() const { return type_ == Type::Array; }
    bool isString() const { return type_ == Type::String; }
    bool isNumber() const { return type_ == Type::Int || type_ == Type::Double; }

    bool asBool() const;
    int64_t asInt() const;
    double asDouble() const;
    const std::string& asString() const;
    const Array& asArray() const;
    const Object& asObject() const;

    // Object access. `at` throws when the key is missing; `get` returns null.
    bool has(const std::string& key) const;
    const Json& at(const std::string& key) const;
    const Json& get(const std::string& key) const;
    Json& set(const std::string& key, Json value);  // replaces or appends, returns *this

    // Array access.
    size_t size() const;
    const Json& operator[](size_t i) const;
    Json& push(Json value);  // returns *this

    std::string dump(int indent = -1) const;

private:
    void dumpTo(std::string& out, int indent, int depth) const;

    Type type_ = Type::Null;
    bool b_ = false;
    int64_t i_ = 0;
    double d_ = 0.0;
    std::string s_;
    Array a_;
    Object o_;
};

}  // namespace cl
