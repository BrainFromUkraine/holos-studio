//! Small platform helpers for child processes.
//!
//! On Windows:
//! * `hide_window` adds `CREATE_NO_WINDOW`, so `uv.exe` / `holos.exe` never flash a console window.
//! * `KillOnClose` is a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Every process we start is put in it,
//!   and so are the processes *they* start (the `holos.exe` launcher starts `python.exe`). When Holos Studio exits —
//!   normally, by crash or because the updater closes it — Windows closes the job handle and kills them all, so no
//!   orphaned engine is left holding the GPU.
//!
//! Elsewhere (Linux / macOS dev builds) these are no-ops: the engine is only managed in Windows release builds,
//! and `Child::kill` is enough for the rare non-Windows release build.

use std::process::{Child, Command};

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    pub fn hide_window(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    pub struct KillOnClose(HANDLE);

    // A job handle is a plain kernel handle: safe to use from any thread.
    unsafe impl Send for KillOnClose {}
    unsafe impl Sync for KillOnClose {}

    impl KillOnClose {
        pub fn new() -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }

        /// Put a freshly spawned child (and its future children) into the job.
        pub fn assign(&self, child: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }

        /// Kill every process in the job (the job itself stays usable for the next child).
        pub fn terminate_all(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for KillOnClose {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::process::{Child, Command};

    pub fn hide_window(_cmd: &mut Command) {}

    pub struct KillOnClose;

    impl KillOnClose {
        pub fn new() -> Option<Self> {
            Some(Self)
        }
        pub fn assign(&self, _child: &Child) -> bool {
            true
        }
        pub fn terminate_all(&self) {}
    }
}

pub use imp::KillOnClose;

/// Never show a console window for this command (Windows); no-op elsewhere.
pub fn hide_window(cmd: &mut Command) {
    imp::hide_window(cmd)
}

/// Best effort: kill the whole job, then the child itself, and reap it.
pub fn kill(job: Option<&KillOnClose>, child: &mut Child) {
    if let Some(job) = job {
        job.terminate_all();
    }
    let _ = child.kill();
    let _ = child.wait();
}
