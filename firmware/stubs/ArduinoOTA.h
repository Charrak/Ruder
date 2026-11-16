#pragma once
#include "Arduino.h"

enum ota_error_t { OTA_AUTH_ERROR };

struct ArduinoOTAClass {
  void setHostname(const char *) {}
  void setPassword(const char *) {}
  void onStart(void (*)()) {}
  void onEnd(void (*)()) {}
  void onError(void (*)(ota_error_t)) {}
  void begin() {}
  void handle() {}
};

extern ArduinoOTAClass ArduinoOTA;
