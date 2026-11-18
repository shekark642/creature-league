add_library(cl_sim
  src/json.cpp
  src/catalog.cpp
  src/battle.cpp
)
target_include_directories(cl_sim PUBLIC include)
if(MSVC)
  target_compile_options(cl_sim PRIVATE /W4)
else()
  target_compile_options(cl_sim PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(clsim tools/clsim.cpp)
target_link_libraries(clsim PRIVATE cl_sim)

add_executable(cl_tests tests/tests.cpp)
target_link_libraries(cl_tests PRIVATE cl_sim)
target_compile_definitions(cl_tests PRIVATE CL_DATA_DIR="${PROJECT_SOURCE_DIR}/data"
                                            CL_EXAMPLES_DIR="${PROJECT_SOURCE_DIR}/examples")
add_test(NAME cl_tests COMMAND cl_tests)
