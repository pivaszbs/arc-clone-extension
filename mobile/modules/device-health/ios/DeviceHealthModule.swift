import ExpoModulesCore
import UIKit

/// Battery, charging, Low Power Mode and thermal state, so the worker node only
/// processes video when the phone can afford it (PIPELINE.md step 3).
public class DeviceHealthModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DeviceHealth")

    AsyncFunction("getHealthAsync") { () -> [String: Any] in
      let device = UIDevice.current
      device.isBatteryMonitoringEnabled = true

      let power: String
      switch device.batteryState {
      case .charging: power = "charging"
      case .full: power = "full"
      case .unplugged: power = "battery"
      default: power = "unknown"
      }

      let thermal: String
      switch ProcessInfo.processInfo.thermalState {
      case .nominal: thermal = "nominal"
      case .fair: thermal = "fair"
      case .serious: thermal = "serious"
      case .critical: thermal = "critical"
      @unknown default: thermal = "nominal"
      }

      var result: [String: Any] = [
        "power": power,
        "thermal": thermal,
        "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
      ]
      // -1 when unknown (e.g. simulator).
      if device.batteryLevel >= 0 {
        result["batteryLevel"] = Double(device.batteryLevel)
      }
      return result
    }.runOnQueue(.main)
  }
}
