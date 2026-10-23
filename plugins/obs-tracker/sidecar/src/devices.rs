//! Video capture devices (webcams).
//!
//! Windows: DirectShow (`CLSID_VideoInputDeviceCategory`), the same list OBS's
//! `dshow_input` shows. The plugin is declared Windows-only (manifest
//! `platforms: ["windows"]`): on macOS/Linux OBS uses other input kinds and
//! device-id properties (`macos-avcapture` / `v4l2_input`) that this tracker does
//! not drive, so enumeration there returns an empty list instead of a guess.

use serde::{Deserialize, Serialize};

/// Video capture device (webcam)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoDevice {
    pub id: String,
    pub name: String,
}

pub use video_devices::enumerate_video_devices;

#[cfg(windows)]
mod video_devices {
    use super::VideoDevice;
    use windows::Win32::Media::DirectShow::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Com::StructuredStorage::IPropertyBag;
    use windows::Win32::System::Variant::*;
    use windows::core::*;

    // CLSIDs for DirectShow device enumeration
    const CLSID_SYSTEM_DEVICE_ENUM: GUID = GUID::from_u128(0x62BE5D10_60EB_11d0_BD3B_00A0C911CE86);
    const CLSID_VIDEO_INPUT_DEVICE_CATEGORY: GUID = GUID::from_u128(0x860BB310_5D01_11d0_BD3B_00A0C911CE86);

    pub fn enumerate_video_devices() -> Vec<VideoDevice> {
        let mut devices = Vec::new();

        unsafe {
            // Initialize COM
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            // Create the System Device Enumerator
            let dev_enum: ICreateDevEnum = match CoCreateInstance(
                &CLSID_SYSTEM_DEVICE_ENUM,
                None,
                CLSCTX_INPROC_SERVER,
            ) {
                Ok(e) => e,
                Err(_) => return devices,
            };

            // Create an enumerator for video capture devices
            let mut enum_moniker: Option<IEnumMoniker> = None;
            if dev_enum
                .CreateClassEnumerator(
                    &CLSID_VIDEO_INPUT_DEVICE_CATEGORY,
                    &mut enum_moniker,
                    0,
                )
                .is_err()
            {
                return devices;
            }

            let enum_moniker = match enum_moniker {
                Some(e) => e,
                None => return devices,
            };

            // Enumerate devices
            loop {
                let mut moniker_array = [None; 1];
                let mut fetched = 0u32;
                if enum_moniker.Next(&mut moniker_array, Some(&mut fetched)).is_err() || fetched == 0 {
                    break;
                }

                let moniker = match &moniker_array[0] {
                    Some(m) => m,
                    None => continue,
                };

                // Get the property bag
                let property_bag: IPropertyBag = match moniker.BindToStorage(None, None) {
                    Ok(pb) => pb,
                    Err(_) => continue,
                };

                // Get the FriendlyName
                let mut var_name = VARIANT::default();
                let friendly_name_key = w!("FriendlyName");
                if property_bag.Read(friendly_name_key, &mut var_name, None).is_ok() {
                    let vt = var_name.as_raw().Anonymous.Anonymous.vt;
                    if vt == VT_BSTR.0 {
                        let bstr_ptr = var_name.as_raw().Anonymous.Anonymous.Anonymous.bstrVal;
                        if !bstr_ptr.is_null() {
                            let bstr = BSTR::from_raw(bstr_ptr);
                            let name = bstr.to_string();
                            std::mem::forget(bstr);

                            // Get the DevicePath as ID
                            let mut var_path = VARIANT::default();
                            let device_path_key = w!("DevicePath");
                            let device_id = if property_bag.Read(device_path_key, &mut var_path, None).is_ok() {
                                let vt_path = var_path.as_raw().Anonymous.Anonymous.vt;
                                if vt_path == VT_BSTR.0 {
                                    let bstr_path_ptr = var_path.as_raw().Anonymous.Anonymous.Anonymous.bstrVal;
                                    if !bstr_path_ptr.is_null() {
                                        let bstr_path = BSTR::from_raw(bstr_path_ptr);
                                        let path = bstr_path.to_string();
                                        std::mem::forget(bstr_path);
                                        path
                                    } else {
                                        name.clone()
                                    }
                                } else {
                                    name.clone()
                                }
                            } else {
                                name.clone()
                            };

                            devices.push(VideoDevice {
                                id: device_id,
                                name,
                            });
                        }
                    }
                }
            }
        }

        devices
    }
}

#[cfg(not(windows))]
mod video_devices {
    use super::VideoDevice;

    /// Not supported off Windows (see the module docs).
    pub fn enumerate_video_devices() -> Vec<VideoDevice> {
        Vec::new()
    }
}
