#pragma once
#include "Arduino.h"

struct MDNSClass {
  bool begin(const char *) { return true; }
  void addService(const char *, const char *, uint16_t) {}
};

extern MDNSClass MDNS;
