# Host-Werkzeuge für die Firmware (kein ESP32 nötig).
#
#   make test             Impulsverarbeitung testen
#   make check-syntax     main.cpp gegen Arduino-Stubs übersetzen
#   make all              beides

CXX ?= g++
CXXFLAGS ?= -O2 -Wall -Wextra -Wpedantic

# Zwei Standards prüfen: C++17 für die Host-Tests und gnu++11, weil die
# ESP32-Toolchain (GCC 8.4 in PlatformIO 6.x) genau damit übersetzt.
# Was hier unter gnu++11 scheitert, scheitert auch im CI-Build.
STANDARD_TEST ?= -std=c++17
STANDARD_FIRMWARE ?= -std=gnu++11
STUB_INCLUDE := stubs
FIRMWARE_INCLUDE := ruder_sensor/include
FIRMWARE_SOURCE := ruder_sensor/src/main.cpp

TEST_BIN := build/test_pulse_filter

.PHONY: all test check-syntax clean

all: test check-syntax

test: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): test/test_pulse_filter.cpp $(FIRMWARE_INCLUDE)/pulse_filter.h
	@mkdir -p build
	$(CXX) $(STANDARD_TEST) $(CXXFLAGS) -I $(FIRMWARE_INCLUDE) -I include -o $@ test/test_pulse_filter.cpp

# Reine Syntax- und Typprüfung: -fsyntax-only braucht keine Implementierungen.
check-syntax:
	@echo "Syntaxprüfung: $(FIRMWARE_SOURCE)"
	$(CXX) $(STANDARD_FIRMWARE) $(CXXFLAGS) -fsyntax-only -I $(STUB_INCLUDE) -I $(FIRMWARE_INCLUDE) $(FIRMWARE_SOURCE)
	@echo "Syntax in Ordnung (gnu++11, wie die ESP32-Toolchain)."

clean:
	rm -rf build
