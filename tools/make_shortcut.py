import struct, sys
def s(t): return struct.pack('<H', len(t)) + t.encode('utf-16-le')
def lnk(target, workdir, desc, icon, env_target):
    flags = 0x02 | 0x04 | 0x10 | 0x40 | 0x80 | 0x200  # LinkInfo, Name, WorkingDir, IconLocation, Unicode, HasExpString
    hdr = struct.pack('<I16sIIQQQIiIHHII', 0x4C, bytes.fromhex('0114020000000000c000000000000046'),
                      flags, 0x20, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0)
    assert len(hdr) == 0x4C
    base = target.encode('cp1252') + b'\0'
    vol = struct.pack('<IIII', 0x11, 3, 0, 0x10) + b'\0'
    vid_off = 0x1C; lbp_off = vid_off + len(vol); cps_off = lbp_off + len(base)
    body = vol + base + b'\0'
    li = struct.pack('<IIIIIII', 0x1C + len(body), 0x1C, 0x01, vid_off, lbp_off, 0, cps_off) + body
    strings = s(desc) + s(workdir) + s(icon)
    # EnvironmentVariableDataBlock (0xA0000001): 260-byte ANSI + 520-byte Unicode target
    a = env_target.encode('cp1252')[:259]; u = env_target.encode('utf-16-le')[:518]
    env = struct.pack('<II', 0x314, 0xA0000001) + a + bytes(260 - len(a)) + u + bytes(520 - len(u))
    return hdr + li + strings + env + b'\0\0\0\0'
D = r"C:\Users\User\AppData\Local\Programs\Mike's PDF Studio"
exe = D + r"\Mike's PDF Studio.exe"
data = lnk(exe, D, "Mike's PDF Studio - view, edit, sign, stamp and merge PDFs", exe, r"%LOCALAPPDATA%\Programs\Mike's PDF Studio\Mike's PDF Studio.exe")
open(sys.argv[1], 'wb').write(data); print(len(data))
