import Cocoa
import CoreGraphics

// Disable stdout buffering
setbuf(stdout, nil)

print("DEBUG: Launching recorder (CGEvent)...")

let trusted = AXIsProcessTrusted()
print("DEBUG: AXIsProcessTrusted: \(trusted)")
if !trusted {
    print("WARNING: Accessibility permissions are NOT granted. Global monitoring will fail.")
    print("Please grant Accessibility permissions to your Terminal app.")
}

func callback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .keyDown {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        // r=15, s=1, p=35, space=49, q=12, l=37
        switch keyCode {
        case 15:
            print("r")
        case 1:
            print("s")
        case 35:
            print("p")
        case 49:
            print("space")
        case 12:
            print("q")
        case 37:
            print("l")
        default:
            break
        }
        fflush(stdout)
    }
    return Unmanaged.passUnretained(event)
}

let eventMask = (1 << CGEventType.keyDown.rawValue)
guard let eventTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: CGEventMask(eventMask),
    callback: callback,
    userInfo: nil
) else {
    print("ERROR: Failed to create event tap")
    exit(1)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)

print("READY")
fflush(stdout)

CFRunLoopRun()
