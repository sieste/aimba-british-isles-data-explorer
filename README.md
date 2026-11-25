# British Isles explorer

Web page for exploring the AIMBA British Isles ensemble forecast files (one NetCDF file per model
and wave, `<model>_wave<NN>_british_isles.nc`). The files are read directly from a folder on your
own computer, in the browser, using [h5wasm](https://github.com/usnistgov/h5wasm) (HDF5 compiled
to WebAssembly). Nothing is uploaded: the page reads only the parts of each file it needs.

**Use:** open the page, press *Choose folder…* (or drag the folder onto the page) and pick the folder with the files (a wave folder,
or the folder above it for all waves). Then choose a grid point or a region (with area mean, sum
or standard deviation), a variable and a lead time. All initial times are shown as a time series,
one colour per model, as all members or as an ensemble summary. *Export CSV* downloads the
plotted data.

Needs a current browser (Chrome, Edge, Firefox, Safari) with internet access for the map tiles
and the libraries (Leaflet, Plotly, h5wasm). A new variable or lead time takes a few seconds to
read; repeated selections are cached.

`prototype/` is the first speed test of in-browser reading.
