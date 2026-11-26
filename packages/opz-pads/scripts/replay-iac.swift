#!/usr/bin/env swift

import CoreMIDI
import Foundation
import AudioToolbox

let recordedEvents: [(delay: TimeInterval, bytes: [UInt8])] = [
    (0, [0x95, 0x4a, 0x64]),
    (3.881, [0xba, 0x78, 0x00]),
    (3.882, [0xba, 0x7b, 0x00]),
    (4.920, [0x85, 0x4a, 0x00]),
]

func name(_ object: MIDIObjectRef, _ property: CFString) -> String? {
    var value: Unmanaged<CFString>?
    guard MIDIObjectGetStringProperty(object, property, &value) == noErr,
          let value = value?.takeRetainedValue() else { return nil }
    return value as String
}

func endpointName(_ endpoint: MIDIEndpointRef) -> String {
    let display = name(endpoint, kMIDIPropertyDisplayName)
    if let display, display == "IAC Driver Bus 1" { return display }
    var entity = MIDIEntityRef()
    var device = MIDIDeviceRef()
    if MIDIEndpointGetEntity(endpoint, &entity) == noErr,
       MIDIEntityGetDevice(entity, &device) == noErr,
       let deviceName = name(device, kMIDIPropertyName),
       let endpointName = name(endpoint, kMIDIPropertyName) {
        return "\(deviceName) \(endpointName)"
    }
    return display ?? name(endpoint, kMIDIPropertyName) ?? "(unnamed)"
}

let arguments = Array(CommandLine.arguments.dropFirst())
let validArguments = Set(["--dry-run", "--list", "--notes-only", "--cc120", "--cc123", "--channel6"])
let selectedModes = ["--notes-only", "--cc120", "--cc123"].filter { arguments.contains($0) }
guard arguments.allSatisfy({ validArguments.contains($0) }),
      Set(arguments).count == arguments.count,
      selectedModes.count <= 1,
      !(arguments.contains("--channel6") && selectedModes.first != "--cc120" && selectedModes.first != "--cc123"),
      !(arguments.contains("--list") && arguments.count != 1) else {
    fputs("Usage: swift replay-iac.swift [--notes-only | --cc120 | --cc123] [--channel6] [--dry-run] | --list\n", stderr)
    exit(2)
}
let events = recordedEvents.filter { event in
    guard event.bytes[0] & 0xf0 == 0xb0 else { return true }
    if arguments.contains("--notes-only") { return false }
    if arguments.contains("--cc120") { return event.bytes[1] == 120 }
    if arguments.contains("--cc123") { return event.bytes[1] == 123 }
    return true
}.map { event in
    (delay: event.delay, bytes: arguments.contains("--channel6") && event.bytes[0] & 0xf0 == 0xb0
        ? [UInt8(0xb5), event.bytes[1], event.bytes[2]] : event.bytes)
}

if arguments.contains("--dry-run") {
    for event in events {
        print(String(format: "%.3f", event.delay), event.bytes.map { String(format: "%02X", $0) }.joined(separator: " "))
    }
    exit(0)
}

let destinations = (0..<MIDIGetNumberOfDestinations()).map { MIDIGetDestination($0) }
if arguments.contains("--list") {
    for destination in destinations { print(endpointName(destination)) }
    exit(0)
}

let matches = destinations.filter { endpointName($0) == "IAC Driver Bus 1" }
guard matches.count == 1, let destination = matches.first else {
    fputs("Expected exactly one IAC Driver Bus 1 destination; found \(matches.count). Run with --list to inspect destinations.\n", stderr)
    exit(1)
}

var client = MIDIClientRef()
var status = MIDIClientCreate("OP-Z IAC replay" as CFString, nil, nil, &client)
guard status == noErr else {
    fputs("Could not create MIDI client: \(status)\n", stderr)
    exit(1)
}
defer { MIDIClientDispose(client) }
var port = MIDIPortRef()
status = MIDIOutputPortCreate(client, "Replay output" as CFString, &port)
guard status == noErr else {
    fputs("Could not create MIDI output: \(status)\n", stderr)
    exit(1)
}
defer { MIDIPortDispose(port) }

print("Sending the recorded sequence to IAC Driver Bus 1.")
let start = ProcessInfo.processInfo.systemUptime
for event in events {
    let remaining = start + event.delay - ProcessInfo.processInfo.systemUptime
    if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
    var packetList = MIDIPacketList()
    status = withUnsafeMutablePointer(to: &packetList) { list in
        let packet = MIDIPacketListInit(list)
        return event.bytes.withUnsafeBufferPointer { bytes in
            let added: UnsafeMutablePointer<MIDIPacket>? = MIDIPacketListAdd(
                list, MemoryLayout<MIDIPacketList>.size, packet, AudioGetCurrentHostTime(), bytes.count, bytes.baseAddress!
            )
            guard added != nil else {
                return OSStatus(-1)
            }
            return MIDISend(port, destination, list)
        }
    }
    guard status == noErr else {
        fputs("MIDI send failed (\(status)) for \(event.bytes.map { String(format: "%02X", $0) }.joined(separator: " ")).\n", stderr)
        exit(1)
    }
    print(String(format: "%.3f", event.delay), event.bytes.map { String(format: "%02X", $0) }.joined(separator: " "))
}
