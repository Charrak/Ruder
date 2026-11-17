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
  // String-Variante: der Server gibt den Inhalt als UriText aus.
  void sendContent(const String &) {}
  // Die echte Klasse nimmt Zeiger + Laenge; genau so wird es hier benutzt.
  void sendContent(const char *, size_t) {}
  void sendContent_P(const char *, size_t) {}
  void sendHeader(const String &, const String &) {}
  void sendHeader(const char *, const char *) {}
  void setContentLength(size_t) {}
  String header(const String &) { return String(""); }
  String header(const char *) { return String(""); }
  String uri() { return String("/"); }
  void send_P(int, const char *, const char *, size_t) {}
};
