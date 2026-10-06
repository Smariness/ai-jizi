// B8 验收辅助：读取/临时关闭 Wi-Fi 软件射频，保留原值供 finally 恢复。
// https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlansetinterface
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class B8WlanRadio {
    [StructLayout(LayoutKind.Sequential)] struct Radio { public uint Phy; public uint Software; public uint Hardware; }
    [DllImport("wlanapi.dll")] static extern uint WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr handle);
    [DllImport("wlanapi.dll")] static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern uint WlanQueryInterface(IntPtr handle, ref Guid guid, uint opcode, IntPtr reserved, out uint size, out IntPtr data, out uint valueType);
    [DllImport("wlanapi.dll")] static extern uint WlanSetInterface(IntPtr handle, ref Guid guid, uint opcode, uint size, ref Radio data, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr data);
    static IntPtr Open() {
        IntPtr handle; uint version; var error = WlanOpenHandle(2, IntPtr.Zero, out version, out handle);
        if (error != 0) throw new Win32Exception((int)error); return handle;
    }
    public static uint[] Read(Guid guid) {
        var handle = Open(); IntPtr data = IntPtr.Zero;
        try {
            uint size, valueType;
            var error = WlanQueryInterface(handle, ref guid, 4, IntPtr.Zero, out size, out data, out valueType);
            if (error != 0) throw new Win32Exception((int)error);
            var count = Marshal.ReadInt32(data);
            if (count < 1 || count > 64 || size < 4 + count * 12) throw new InvalidOperationException("Invalid WLAN_RADIO_STATE");
            var result = new uint[count * 3];
            for (int n = 0; n < result.Length; n++) result[n] = (uint)Marshal.ReadInt32(data, 4 + n * 4);
            return result;
        } finally { if (data != IntPtr.Zero) WlanFreeMemory(data); WlanCloseHandle(handle, IntPtr.Zero); }
    }
    public static uint Set(Guid guid, uint phy, uint software) {
        if (software != 1 && software != 2) throw new ArgumentOutOfRangeException("software");
        var handle = Open();
        try { var state = new Radio { Phy = phy, Software = software, Hardware = 0 };
            return WlanSetInterface(handle, ref guid, 4, 12, ref state, IntPtr.Zero);
        } finally { WlanCloseHandle(handle, IntPtr.Zero); }
    }
}
