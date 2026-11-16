#pragma once
#include "Arduino.h"

enum WStype_t { WStype_DISCONNECTED, WStype_CONNECTED, WStype_TEXT };

struct WebSocketsServer {
  explicit WebSocketsServer(uint16_t) {}
  void begin() {}
  void loop() {}
  void onEvent(void (*)(uint8_t, WStype_t, uint8_t *, size_t)) {}
  void enableHeartbeat(uint32_t, uint32_t, uint8_t) {}
  // Echte Signaturen der Lib: uint8_t* (nicht const) und String
  void broadcastTXT(const String &) {}
  void broadcastTXT(const char *) {}
  void broadcastTXT(const uint8_t *, size_t) {}
  void sendTXT(uint8_t, const String &) {}
  void sendTXT(uint8_t, const char *) {}
  void sendTXT(uint8_t, const uint8_t *, size_t) {}
  IPAddress remoteIP(uint8_t) { return IPAddress(); }
  uint8_t connectedClients() { return 0; }
};
