fn main() {
    println!("cargo:rerun-if-changed=../dist/index.html");
    println!("cargo:rerun-if-changed=../dist/assets/app.js");
    println!("cargo:rerun-if-changed=../dist/assets/index.css");
    tauri_build::build()
}
