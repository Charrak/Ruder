#pragma once
#include "Arduino.h"

#define WIFI_STA 1
#define WIFI_AP 2
#define WL_CONNECTED 3

struct WiFiClass {
  void mode(int) {}
  bool setHostname(const char *) { return true; }
  bool setSleep(bool) { return true; }
  void begin(const char *, const char *) {}
  int status() { return WL_CONNECTED; }
  int channel() { return 6; }
  int RSSI() { return -58; }
  void disconnect() {}
  IPAddress localIP() { return IPAddress(); }
  IPAddress softAPIP() { return IPAddress(); }
  bool softAP(const char *) { return true; }
  bool config(IPAddress, IPAddress, IPAddress, IPAddress) { return true; }
};

extern WiFiClass WiFi;
