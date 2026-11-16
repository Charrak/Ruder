/**
 * Host-Test der Impuls-Vorverarbeitung (kein ESP32 nötig).
 *
 *   cd firmware && make test
 *
 * Prüft die drei Fehler, die am Gerät am teuersten sind: Prellen erzeugt
 * Geisterimpulse, ein voller Puffer verschluckt echte Impulse, und die
 * Diagnosewerte müssen stimmen, weil man damit den Magneten ausrichtet.
 */

#include <cassert>
#include <cstdio>
#include <vector>

#include "pulse_filter.h"

namespace {

int failures = 0;

void check(bool condition, const char *message) {
  if (!condition) {
    std::printf("  FEHLER: %s\n", message);
    failures++;
  }
}

void testAcceptsCleanPulses() {
  std::printf("saubere Impulse\n");
  ruder::PulseFilter<8> filter;
  // 6 Impulse/Umdrehung bei 30 U/min: 333 ms pro Impuls
  uint32_t t = 1000;
  for (int i = 0; i < 6; i++) {
    check(filter.accept(t), "Impuls muss angenommen werden");
    t += 333'333;
  }
  check(filter.stats().accepted == 6, "6 angenommene Impulse");
  check(filter.pending() == 6, "6 Impulse im Puffer");
  check(filter.stats().minPeriodUs == 333'333, "Abstand erkannt");
}

void testRejectsBounce() {
  std::printf("Prellen\n");
  ruder::PulseFilter<16> filter;
  filter.accept(10'000);
  // Prellen in den ersten 3 ms
  check(!filter.accept(10'500), "0,5 ms später ist Prellen");
  check(!filter.accept(12'900), "2,9 ms später ist Prellen");
  check(filter.stats().bounced == 2, "2 verworfene Prellimpulse");
  check(filter.accept(13'100), "3,1 ms später ist echt");
  check(filter.stats().accepted == 2, "nur echte Impulse zählen");
}

void testDrainOrderAndWrap() {
  std::printf("Puffern und Auslesen\n");
  ruder::PulseFilter<4> filter;
  ruder::TimedPulse out[4];
  uint32_t t = 0;
  for (int i = 0; i < 3; i++) {
    t += 5000;
    filter.accept(t);
  }
  check(filter.drain(out, 4) == 3, "3 Impulse auslesen");
  check(out[0].micros == 5000 && out[2].micros == 15000, "Reihenfolge bleibt erhalten");
  check(out[0].millis == 5, "Millis aus Mikros abgeleitet");

  // Ringspeicher umlaufen lassen
  for (int i = 0; i < 10; i++) {
    t += 5000;
    filter.accept(t);
    filter.drain(out, 1);
  }
  check(filter.pending() == 0, "nach jedem Lesen wieder leer");
}

void testOverflowIsCounted() {
  std::printf("Pufferüberlauf\n");
  ruder::PulseFilter<4> filter;
  uint32_t t = 0;
  size_t accepted = 0;
  for (int i = 0; i < 10; i++) {
    t += 5000;
    if (filter.accept(t)) accepted++;
  }
  // Kapazität 4, ein Slot bleibt als Unterscheidung frei -> 3 Plätze
  check(accepted == 3, "nur 3 Impulse passen in den Puffer");
  check(filter.stats().dropped == 7, "7 Verwürfe gezählt");
  check(filter.stats().accepted == 3, "angenommene Impulse separat gezählt");
}

void testMaxRate() {
  std::printf("Diagnosewerte\n");
  ruder::PulseFilter<16> filter;
  filter.accept(0);
  filter.accept(4000);   // 250 Hz
  filter.accept(10'000); // 6 ms
  check(filter.maxRateHz() > 249.9F && filter.maxRateHz() < 250.1F, "250 Hz erkannt");
  check(filter.stats().maxPeriodUs == 6000, "längster Abstand erkannt");
}

void testMicrosWraparound() {
  std::printf("Überlauf der Mikrosekunden\n");
  ruder::PulseFilter<8> filter;
  // esp_timer läuft nach ~71 Minuten über. Ein Impuls kurz davor, einer
  // kurz danach: die Differenz muss trotzdem stimmen.
  const uint32_t before = 0xFFFFFFFFu - 1000;
  filter.accept(before);
  check(filter.accept(2000), "Impuls nach dem Überlauf wird angenommen");
  check(filter.stats().minPeriodUs == 3001, "Abstand über den Überlauf hinweg korrekt");
}

}  // namespace

int main() {
  std::printf("Ruder-Sensor: Test der Impulsverarbeitung\n\n");
  testAcceptsCleanPulses();
  testRejectsBounce();
  testDrainOrderAndWrap();
  testOverflowIsCounted();
  testMaxRate();
  testMicrosWraparound();
  if (failures == 0) {
    std::printf("\nAlle Tests bestanden.\n");
    return 0;
  }
  std::printf("\n%d Fehler.\n", failures);
  return 1;
}
