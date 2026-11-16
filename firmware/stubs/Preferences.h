#pragma once
#include "Arduino.h"

struct Preferences {
  bool begin(const char *, bool) { return true; }
  void end() {}
  String getString(const char *, const char *) { return String(""); }
  size_t putString(const char *, const String &) { return 0; }
};
