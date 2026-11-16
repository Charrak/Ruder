/**
 * Impuls-Vorverarbeitung des Ruder-Sensors.
 *
 * Bewusst frei von Arduino-Abhängigkeiten: dieselbe Datei läuft im ESP32
 * und in einem Host-Test (`firmware/test/test_pulse_filter.cpp`). Der
 * Interrupt-Teil ist die Stelle, an der Fehler am teuersten sind – Prellen
 * erzeugt Geisterimpulse, ein Pufferüberlauf verschluckt echte.
 */
#pragma once

#include <cstddef>
#include <cstdint>

namespace ruder {

struct TimedPulse {
  uint32_t millis;
  uint32_t micros;
};

struct PulseStats {
  uint32_t accepted = 0;
  uint32_t bounced = 0;
  uint32_t dropped = 0;
  uint32_t lastMicros = 0;
  uint32_t minPeriodUs = UINT32_MAX;
  uint32_t maxPeriodUs = 0;
};

struct FilterConfig {
  uint32_t debounceUs = 3000;

  /**
   * Standardkonstruktor bewusst ausgeschrieben.
   *
   * Mit dem Standardparameter `= 3000` in C++11 wurde die Klasse von
   * Aggregat-Initialisierung ausgeschlossen; `FilterConfig{DEBOUNCE_US}`
   * ist bei älteren GCC-Versionen der ESP32-Toolchain (8.4 in PlatformIO
   * 6.x, Standard dort gnu++11) dann kein gültiger Ausdruck. So geht beides:
   * `FilterConfig{}` und `FilterConfig{ms}`.
   */
  FilterConfig() = default;
  explicit FilterConfig(uint32_t us) : debounceUs(us) {}
};

/**
 * Ein Slot im Ringpuffer. `millis` und `micros` getrennt, weil das
 * Dashboard mit Millisekunden rechnet, die Diagnose aber Mikrosekunden
 * braucht.
 */
template <size_t Capacity>
class PulseFilter {
 public:
  explicit PulseFilter(FilterConfig config = {}) : config_(config) {}

  /**
   * Verarbeitet einen Sensorflanken-Zeitstempel (Mikrosekunden).
   * Gibt true zurück, wenn der Impuls angenommen und gepuffert wurde.
   */
  bool accept(uint32_t micros) {
    // Eigenes Flag statt "lastMicros == 0": der erste Impuls kann
    // theoretisch genau bei 0 liegen, dann fehlte die Messung.
    if (hasLast_) {
      const uint32_t period = micros - stats_.lastMicros;
      if (period < config_.debounceUs) {
        stats_.bounced++;
        return false;
      }
      if (period < stats_.minPeriodUs) stats_.minPeriodUs = period;
      if (period > stats_.maxPeriodUs) stats_.maxPeriodUs = period;
    }
    stats_.lastMicros = micros;
    hasLast_ = true;

    const size_t next = (head_ + 1) % Capacity;
    if (next == tail_) {
      // Puffer voll: der Verbraucher kommt nicht hinterher. Verwerfen und
      // zählen, damit es auf der Diagnoseseite sichtbar wird.
      stats_.dropped++;
      return false;
    }
    buffer_[head_] = TimedPulse{micros / 1000, micros};
    head_ = next;
    stats_.accepted++;
    return true;
  }

  /** Holt bis zu `max` Impulse in `out`. Gibt die Anzahl zurück. */
  size_t drain(TimedPulse *out, size_t max) {
    size_t count = 0;
    while (count < max && tail_ != head_) {
      out[count++] = buffer_[tail_];
      tail_ = (tail_ + 1) % Capacity;
    }
    return count;
  }

  size_t pending() const {
    return (head_ + Capacity - tail_) % Capacity;
  }

  const PulseStats &stats() const { return stats_; }

  /** Für Tests und den Werksreset. */
  void reset() {
    head_ = 0;
    tail_ = 0;
    hasLast_ = false;
    stats_ = PulseStats{};
  }

  /** Höchste gemessene Impulsrate in Hz (0, solange kein zweiter Impuls kam). */
  float maxRateHz() const {
    if (stats_.minPeriodUs == 0 || stats_.minPeriodUs == UINT32_MAX) return 0.0F;
    return 1000000.0F / static_cast<float>(stats_.minPeriodUs);
  }

 private:
  FilterConfig config_;
  TimedPulse buffer_[Capacity]{};
  size_t head_ = 0;
  size_t tail_ = 0;
  bool hasLast_ = false;
  PulseStats stats_{};
};

}  // namespace ruder
