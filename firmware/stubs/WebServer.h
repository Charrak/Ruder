#pragma once
#include "Arduino.h"

#define HTTP_GET 1
#define HTTP_POST 2

struct WebServer {
  explicit WebServer(uint16_t) {}
  void on(const char *, int, void (*)()) {}
  void onNotFound(void (*)()) {}
  void begin() {}
  void handleClient() {}
  String arg(const char *) { return String(""); }
  void send(int, const char *, const String &) {}
  void send(int, const char *, const char *) {}
};
