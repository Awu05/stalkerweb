# The Solo app's native bridge: starts nodejs-mobile's Node (libnode.so) from
# Kotlin (NodejsMobileRuntime). libnode.so and its headers come from
# android/scripts/fetch-libnode.sh, in android/app/libnode/.
cmake_minimum_required(VERSION 3.22.1)
project(stalkerweb-solo CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Built by the :solonative module (android/solonative), which only the Solo
# variants depend on; it passes this. The remote apps build no native code.
if(NOT STALKERWEB_SOLO)
  return()
endif()

set(LIBNODE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode)
if(NOT EXISTS ${LIBNODE_DIR}/jniLibs/${ANDROID_ABI}/libnode.so)
  message(FATAL_ERROR "No libnode.so for ${ANDROID_ABI} — run android/scripts/fetch-libnode.sh first")
endif()

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/jniLibs/${ANDROID_ABI}/libnode.so)

add_library(node-bridge SHARED node-bridge.cpp)
target_include_directories(node-bridge PRIVATE ${LIBNODE_DIR}/include/node)
target_link_libraries(node-bridge node log)
