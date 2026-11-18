#pragma once
#include <cstdint>
#include <cstdio>
#include <cstddef>
#include <string>

class String {
 public:
  String() {}
  String(const char *s) : v(s ? s : "") {}
  String(const std::string &s) : v(s) {}
  // Arduino: String(char*, len) – wird von WebSockets-Nachrichten genutzt
  String(const char *s, size_t len) : v(s ? std::string(s, len) : std::string()) {}
  explicit String(int value) : v(std::to_string(value)) {}
  explicit String(unsigned value) : v(std::to_string(value)) {}
  explicit String(long value) : v(std::to_string(value)) {}
  explicit String(unsigned long value) : v(std::to_string(value)) {}
  String(float value) : v(std::to_string(value)) {}
  String(double value) : v(std::to_string(value)) {}
  // Arduino: String(float, nachkommastellen)
  String(float value, int decimals) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%.*f", decimals, static_cast<double>(value));
    v = buf;
  }

  const char *c_str() const { return v.c_str(); }
  size_t length() const { return v.size(); }
  bool startsWith(const char *prefix) const { return v.rfind(prefix, 0) == 0; }
  int indexOf(char c) const {
    const size_t pos = v.find(c);
    return pos == std::string::npos ? -1 : static_cast<int>(pos);
  }
  String substring(size_t from) const { return String(v.substr(from)); }
  String substring(size_t from, size_t to) const { return String(v.substr(from, to - from)); }
  char operator[](size_t i) const { return v[i]; }
  String &operator+=(const String &o) { v += o.v; return *this; }
  String &operator+=(const char *o) { v += o; return *this; }
  String &operator+=(char o) { v += o; return *this; }
  void reserve(size_t n) { v.reserve(n); }
  void trim() {}
  bool operator==(const char *o) const { return v == o; }
  bool operator==(const String &o) const { return v == o.v; }

 private:
  std::string v;
};

inline String operator+(const String &a, const String &b) { String r(a); r += b; return r; }
inline String operator+(const String &a, const char *b) { String r(a); r += b; return r; }
inline String operator+(const char *a, const String &b) { String r(a); r += b; return r; }

#define F(x) (x)

// Flash-Attribute wie auf dem ESP32. Auf dem Rechner ist alles RAM, deshalb
// sind es leere Huelle – der Syntaxcheck prueft nur die Aufrufstellen.
#ifndef PROGMEM
#define PROGMEM
#endif
#ifndef PGM_P
#define PGM_P const char *
#endif
#ifndef pgm_read_byte
#define pgm_read_byte(addr) (*reinterpret_cast<const uint8_t *>(addr))
#endif

#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define RISING 3
#define FALLING 4

typedef uint8_t byte;

struct IPAddress {
  bool fromString(const char *s) { (void)s; return true; }
  String toString() const { return String("192.168.1.50"); }
};

void pinMode(uint8_t pin, uint8_t mode);
void attachInterrupt(uint8_t interrupt, void (*fn)(), uint8_t mode);
uint8_t digitalPinToInterrupt(uint8_t pin);
unsigned long millis();
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
void ESP_restart();
struct EspClass {
  void restart();
  uint32_t getFreeHeap() const;
};
extern EspClass ESP;

struct SerialStub {
  void begin(unsigned long) {}
  void print(const char *) {}
  void print(const String &) {}
  void println() {}
  void println(const char *) {}
  // Bis C++17 nachbilden, ohne Fold-Expression: sonst warnt der
  // Syntaxcheck unter gnu++11 (Standard der ESP32-Toolchain).
  template <typename... A>
  void printf(const char *fmt, A... args) {
    (void)fmt;
    int dummy[] = {0, (static_cast<void>(args), 0)...};
    (void)dummy;
  }
};
extern SerialStub Serial;


#define IRAM_ATTR
typedef uint32_t portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
void portENTER_CRITICAL(portMUX_TYPE *m);
void portEXIT_CRITICAL(portMUX_TYPE *m);
void portENTER_CRITICAL_ISR(portMUX_TYPE *m);
void portEXIT_CRITICAL_ISR(portMUX_TYPE *m);
