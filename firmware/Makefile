# Host-Tests für die Firmware-Logik (kein ESP32 nötig).
#   make test

CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -I ruder_sensor/include -I include

TEST_BIN := build/test_pulse_filter

.PHONY: test clean

test: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): test/test_pulse_filter.cpp ruder_sensor/include/pulse_filter.h
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -o $@ test/test_pulse_filter.cpp

clean:
	rm -rf build
