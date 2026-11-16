# Host-Werkzeuge für die Firmware (kein ESP32 nötig).
#
#   make test             Impulsverarbeitung testen
#   make check-syntax     main.cpp gegen Arduino-Stubs übersetzen
#   make all              beides

CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic
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
	$(CXX) $(CXXFLAGS) -I $(FIRMWARE_INCLUDE) -I include -o $@ test/test_pulse_filter.cpp

# Reine Syntax- und Typprüfung: -fsyntax-only braucht keine Implementierungen.
check-syntax:
	@echo "Syntaxprüfung: $(FIRMWARE_SOURCE)"
	$(CXX) $(CXXFLAGS) -fsyntax-only -I $(STUB_INCLUDE) -I $(FIRMWARE_INCLUDE) $(FIRMWARE_SOURCE)
	@echo "Syntax in Ordnung."

clean:
	rm -rf build
