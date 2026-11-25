# British Isles reader (prototype)

Reads the AIMBA British Isles NetCDF files directly from a folder on your own computer, in the
browser, using [h5wasm](https://github.com/usnistgov/h5wasm) (HDF5 compiled to WebAssembly).
Nothing is uploaded: the page reads only the parts of each file it needs.

Open the page, choose the folder with the `<model>_wave<NN>_british_isles.nc` files, pick a
variable, lead time and grid point or box, and press **Read**. The table shows how long each file
took; the plot shows all members of each model at every initial time.

Prototype for testing the speed of in-browser reading; the full explorer is a separate Python tool.
